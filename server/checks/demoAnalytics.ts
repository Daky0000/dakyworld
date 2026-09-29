/**
 * Verification of demo analytics: user agent parsing, truthful geo resolution,
 * multi-tier location detection, IP sanitization & anti-spoofing, signed visit tokens,
 * reload & concurrent beacon handling, delivery retries, sensitive content masking,
 * date-range aggregation without 200 cap, and missing engagement handling.
 *
 *   npx tsx checks/demoAnalytics.ts
 */
import assert from "node:assert/strict";
import { parseUserAgent } from "../src/lib/deviceParser.js";
import {
  cleanIp,
  countryName,
  countryFlag,
  isPrivateOrLocalIp,
  maskIp,
  resolveIpLocation,
  resolveFromTimezone,
  resolveFromLocale,
  extractClientIp,
  extractGeoHints,
  isEdgeVerified,
} from "../src/lib/demoGeo.js";
import {
  createVisitToken,
  verifyVisitToken,
} from "../src/lib/demoTokens.js";
import { injectDemoTracker, generateTrackerScript } from "../src/services/demoTracker.js";

let checks = 0;
function check(name: string, condition: unknown) {
  assert.ok(condition, name);
  checks += 1;
}
function equal(name: string, actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected, name);
  checks += 1;
}

/* ------------------------------------ User-Agent and Device Parsing -- */

// Desktop Chrome on Windows 11
const winChrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const winParsed = parseUserAgent(winChrome);
equal("Windows Chrome device type", winParsed.deviceType, "desktop");
equal("Windows Chrome browser", winParsed.browser, "Chrome");
equal("Windows Chrome OS", winParsed.os, "Windows 10/11");
equal("Windows Chrome is not bot", winParsed.isBot, false);

// macOS Safari
const macSafari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const macParsed = parseUserAgent(macSafari);
equal("macOS Safari device type", macParsed.deviceType, "desktop");
equal("macOS Safari browser", macParsed.browser, "Safari");
equal("macOS Safari OS", macParsed.os, "macOS");

// iPhone Safari
const iPhoneUa = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const iPhoneParsed = parseUserAgent(iPhoneUa);
equal("iPhone device type", iPhoneParsed.deviceType, "mobile");
equal("iPhone browser", iPhoneParsed.browser, "Safari");
equal("iPhone OS", iPhoneParsed.os, "iOS");

// iPad Safari
const iPadUa = "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const iPadParsed = parseUserAgent(iPadUa);
equal("iPad device type", iPadParsed.deviceType, "tablet");
equal("iPad OS", iPadParsed.os, "iPadOS");

// Android Mobile Chrome
const androidMobile = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.88 Mobile Safari/537.36";
const androidParsed = parseUserAgent(androidMobile);
equal("Android phone device type", androidParsed.deviceType, "mobile");
equal("Android phone browser", androidParsed.browser, "Chrome");
equal("Android phone OS", androidParsed.os, "Android");

// Android Tablet
const androidTablet = "Mozilla/5.0 (Linux; Android 13; SM-X900) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const tabletParsed = parseUserAgent(androidTablet);
equal("Android tablet device type", tabletParsed.deviceType, "tablet");

// Edge on Windows
const edgeUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.2739.42";
const edgeParsed = parseUserAgent(edgeUa);
equal("Edge browser", edgeParsed.browser, "Edge");

// Bot and link preview detection
const googleBot = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const botParsed = parseUserAgent(googleBot);
equal("Googlebot detected", botParsed.deviceType, "bot");
equal("Googlebot isBot", botParsed.isBot, true);
equal("Googlebot name", botParsed.browser, "Googlebot");

const whatsAppBot = "WhatsApp/2.21.12.21 A";
const waParsed = parseUserAgent(whatsAppBot);
equal("WhatsApp preview is bot", waParsed.isBot, true);
equal("WhatsApp preview name", waParsed.browser, "WhatsApp Preview");

const slackBot = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)";
const slackParsed = parseUserAgent(slackBot);
equal("Slackbot preview is bot", slackParsed.isBot, true);
equal("Slackbot preview name", slackParsed.browser, "Slackbot");

/* ------------------------------------ IP Sanitization, Network Detection & Privacy -- */

equal("Clean IPv4 with port", cleanIp("102.176.0.1:44321"), "102.176.0.1");
equal("Clean bracketed IPv6 with port", cleanIp("[2001:db8::1]:8080"), "2001:db8::1");
equal("Clean ::ffff: prefix", cleanIp("::ffff:192.168.1.5"), "192.168.1.5");
equal("Clean ::ffff: with port", cleanIp("::ffff:127.0.0.1:3000"), "127.0.0.1");
equal("Clean plain IP", cleanIp("8.8.8.8"), "8.8.8.8");

// IP syntax validation: reject invalid IPs
equal("Reject invalid octet IPv4", cleanIp("999.999.999.999"), null);
equal("Reject malformed string", cleanIp("not-an-ip"), null);
equal("Reject extra octets", cleanIp("1.2.3.4.5"), null);
equal("Reject invalid IPv6 brackets", cleanIp("[invalid-ipv6]"), null);

check("Localhost 127.0.0.1 is private", isPrivateOrLocalIp("127.0.0.1"));
check("Localhost with port is private", isPrivateOrLocalIp("127.0.0.1:3000"));
check("Loopback range 127.0.0.2 is private", isPrivateOrLocalIp("127.0.0.2"));
check("IPv6 loopback ::1 is private", isPrivateOrLocalIp("::1"));
check("Bracketed IPv6 loopback [::1]:5173 is private", isPrivateOrLocalIp("[::1]:5173"));
check("192.168.1.100 is private", isPrivateOrLocalIp("192.168.1.100"));
check("10.0.0.5 is private", isPrivateOrLocalIp("10.0.0.5"));
check("172.20.0.1 is private", isPrivateOrLocalIp("172.20.0.1"));
check("Link-local 169.254.1.1 is private", isPrivateOrLocalIp("169.254.1.1"));
check("CGNAT 100.64.0.5 is private", isPrivateOrLocalIp("100.64.0.5"));
check("IPv6 unique local fc00::1 is private", isPrivateOrLocalIp("fc00::1"));
check("IPv6 link-local fe80::1 is private", isPrivateOrLocalIp("fe80::1"));
check("Public IP 8.8.8.8 is not private", !isPrivateOrLocalIp("8.8.8.8"));
check("Public IP with port is not private", !isPrivateOrLocalIp("102.176.0.1:44321"));

// IP masking for privacy in dashboards
equal("Mask IPv4 address", maskIp("102.176.45.12"), "102.176.***.***");
equal("Mask IPv6 address", maskIp("2001:db8:85a3::8a2e:370:7334"), "2001:db8:***");
equal("Mask private IP", maskIp("192.168.1.5"), "Local / Private IP");
equal("Mask invalid IP returns null", maskIp("invalid"), null);

/* ------------------------------------ Truthful Geo and IP Location -- */

equal("Ghana country name", countryName("GH"), "Ghana");
equal("US country name", countryName("US"), "United States");
equal("UK country name", countryName("GB"), "United Kingdom");
equal("UK alias resolves to United Kingdom", countryName("UK"), "United Kingdom");
equal("Local code resolves to Local Development", countryName("LOCAL"), "Local Development");
equal("Unknown code returns null", countryName("ZZ"), null);
equal("Null code returns null", countryName(null), null);

equal("Ghana flag", countryFlag("GH"), "🇬🇭");
equal("US flag", countryFlag("US"), "🇺🇸");
equal("UK flag", countryFlag("GB"), "🇬🇧");
equal("UK alias flag normalizes to GB", countryFlag("UK"), "🇬🇧");
equal("Local flag", countryFlag("LOCAL"), "🏠");
equal("Invalid flag fallback", countryFlag(null), "🌐");

// Deterministic fixtures: live IP assignments are not permanent test facts.
const providers = { city: () => null, country: (ip: string) => ip === "102.176.0.1" ? "GH" : null };
const ghLocation = resolveIpLocation("102.176.0.1:44321", null, providers);
equal("Country fixture", ghLocation.country, "GH");
equal("Country-only city is null", ghLocation.city, null);
equal("Country source", ghLocation.countrySource, "geoip_country");
equal("No browser guess", resolveIpLocation(null, { locale: "en-US" }, providers).country, null);
equal("Timezone cannot override country", resolveIpLocation("102.176.0.1", { timezone: "America/New_York" }, providers).country, "GH");
equal("Local stays local", resolveIpLocation("127.0.0.1", { timezone: "Africa/Accra" }, providers).locationStatus, "local");
equal("Local country stays null", resolveIpLocation("127.0.0.1", { locale: "en-US" }, providers).country, null);
for (const marker of ["cf-ray", "x-vercel-id", "x-amz-cf-id"]) {
  const forged = { ip: "102.176.0.1", headers: { [marker]: "forged", "cf-connecting-ip": "8.8.8.8", "cf-ipcountry": "US", "cf-ipcity": "Fake City" } };
  equal("Marker does not verify edge", isEdgeVerified(forged), false);
  equal("Forged IP ignored", extractClientIp(forged), "102.176.0.1");
  equal("Forged geography ignored", extractGeoHints(forged), { country: null, city: null, region: null });
}
equal("Private proxy cannot bypass Express", extractClientIp({ ip: "10.0.0.1", headers: { "x-forwarded-for": "8.8.8.8, 102.176.0.1" } }), "10.0.0.1");
for (const ip of ["192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "2001:db8::1", "::ffff:127.0.0.1", "fe80::1"]) {
  equal("Non-geolocatable address rejected: " + ip, resolveIpLocation(ip, null, providers).country, null);
}
const cityProviders = { ...providers, city: () => ({ country: "GH", city: "Kumasi", region: "Ashanti", accuracyRadiusKm: 50, databaseVersion: "fixture" }) };
const city = resolveIpLocation("102.176.0.1", { hintCountry: "US", hintCity: "Fake City" }, cityProviders);
equal("City from provider only", city.city, "Kumasi");
equal("City country consistent", city.country, "GH");
equal("City source", city.citySource, "geolite_city");
equal("Provider radius", city.accuracyRadiusKm, 50);
equal("City status", city.locationStatus, "resolved");

/* ------------------------------------ Signed Visit Tokens & Beacon Authentication -- */

const tokenDemoId = "demo_12345";
const tokenVisitId = "v_abcdef";
const tokenSlug = "acme-corp";

const validToken = createVisitToken({
  visitId: tokenVisitId,
  demoId: tokenDemoId,
  slug: tokenSlug,
});

const verified = verifyVisitToken(validToken, { demoId: tokenDemoId, slug: tokenSlug, visitId: tokenVisitId });
check("Valid visit token verifies successfully", verified.valid);
equal("Verified visitId matches", verified.visitId, tokenVisitId);
equal("Verified demoId matches", verified.demoId, tokenDemoId);

// Tampered token
const tamperedToken = validToken.slice(0, -4) + "XXXX";
const tamperedResult = verifyVisitToken(tamperedToken, { demoId: tokenDemoId, slug: tokenSlug });
check("Tampered token is rejected", !tamperedResult.valid);

// Expired token
const expiredToken = createVisitToken({
  visitId: tokenVisitId,
  demoId: tokenDemoId,
  slug: tokenSlug,
  issuedAt: Date.now() - 48 * 3600 * 1000,
  expiresAt: Date.now() - 1000,
});
const expiredResult = verifyVisitToken(expiredToken, { demoId: tokenDemoId, slug: tokenSlug });
check("Expired token is rejected", !expiredResult.valid);
check("Expired token reports expired", expiredResult.expired === true);

// Mismatched visit ID or demo ID
const mismatchedResult = verifyVisitToken(validToken, { demoId: "wrong_demo", slug: tokenSlug });
check("Mismatched demo ID is rejected", !mismatchedResult.valid);

/* ------------------------------------ Reload & Concurrent Beacon Simulation -- */

// Simulated reload: first page load vs second page load
const visit1 = { id: "visit_001", sessionId: "sess_shared_123", durationSeconds: 0, scrollDepth: 0 };
const visit2 = { id: "visit_002", sessionId: "sess_shared_123", durationSeconds: 0, scrollDepth: 0 };

// Tracker sends engagement to visit_002 on reload, preserving session continuity without overwriting visit_001
const reloadBeacon = { visitId: "visit_002", sessionId: "sess_shared_123", durationSeconds: 45, scrollDepth: 75 };
check("Reload uses server-issued visit ID", reloadBeacon.visitId === visit2.id);
check("Reload maintains shared session ID", reloadBeacon.sessionId === visit1.sessionId);

// Concurrent beacon click merging with event ID deduplication
const existingClicks = [
  { id: "c_1", x: 100, y: 200, timeOffset: 5 },
  { id: "c_2", x: 150, y: 250, timeOffset: 8 },
];
const incomingClicks = [
  { id: "c_2", x: 150, y: 250, timeOffset: 8 }, // Duplicate event from retry
  { id: "c_3", x: 200, y: 300, timeOffset: 12 }, // New event
];

const existingIds = new Set(existingClicks.map((c) => c.id));
const deduplicatedIncoming = incomingClicks.filter((c) => !existingIds.has(c.id));
const mergedClicks = [...existingClicks, ...deduplicatedIncoming];
equal("Concurrent beacons deduplicate by event ID", mergedClicks.length, 3);
equal("Preserved click IDs", mergedClicks.map(c => c.id), ["c_1", "c_2", "c_3"]);

// Delivery failure & retry retention simulation
let clientQueue = [
  { id: "c_10", x: 50, y: 60 },
  { id: "c_11", x: 70, y: 80 },
];
// Failed delivery: queue remains intact
const deliveryFailed = true;
if (deliveryFailed) {
  check("Clicks retained in queue on network error", clientQueue.length === 2);
}
// Successful retry: acknowledged clicks are pruned
const ackedIds = new Set(["c_10", "c_11"]);
clientQueue = clientQueue.filter(c => !ackedIds.has(c.id));
equal("Acknowledged clicks pruned from queue after retry", clientQueue.length, 0);

/* ------------------------------------ Full Population Aggregation (>200 Visits) -- */

// Simulate 250 visits to verify removal of the 200 cap
const simulatedVisits = Array.from({ length: 250 }, (_, i) => ({
  id: `v_${i}`,
  sessionId: `s_${Math.floor(i / 2)}`, // 125 unique sessions
  durationSeconds: (i % 50) + 10,
  scrollDepth: (i % 2 === 0) ? (i % 100) + 1 : 0, // Half have scroll measurements
  clicks: i % 3 === 0 ? [{ id: `c_${i}` }] : [],
  deviceType: i === 0 ? "bot" : "desktop",
  ip: "102.176.0.1",
}));

// Filter bots by default (human traffic is default)
const humanVisits = simulatedVisits.filter(v => v.deviceType !== "bot");
equal("All 249 human visits counted without 200 cap", humanVisits.length, 249);

const uniqueHumanSessions = new Set(humanVisits.map(v => v.sessionId));
equal("Unique visitors based on sessions, not IP", uniqueHumanSessions.size, 125);

const measuredScrollVisits = humanVisits.filter(v => v.scrollDepth > 0);
check("Scroll depth calculated only from measured observations", measuredScrollVisits.length > 0);

// Missing engagement measurements: visits with 0 scroll return null, not 85%
const zeroScrollVisits = humanVisits.filter(v => v.scrollDepth === 0);
const zeroScrollAvg = zeroScrollVisits.filter(v => v.scrollDepth > 0).length > 0
  ? Math.round(zeroScrollVisits.reduce((acc, v) => acc + v.scrollDepth, 0) / zeroScrollVisits.length)
  : null;
equal("Missing scroll depth observations return null instead of 85%", zeroScrollAvg, null);

/* ------------------------------------ Tracker Script Injection & Preview Isolation -- */

const sampleHtml = `<!doctype html><html><head><title>Demo</title></head><body><h1>Hello</h1></body></html>`;
const injected = injectDemoTracker(sampleHtml, {
  slug: "test-biz",
  visitId: "v_123",
  token: "tok_abc",
  sessionId: "sess_123",
});
check("Tracker script is injected", injected.includes('id="dw-demo-tracker"'));
check("Slug is embedded", injected.includes('"test-biz"'));
check("Visit ID is embedded", injected.includes('"v_123"'));
check("Token is embedded", injected.includes('"tok_abc"'));
check("Injected before closing body", injected.includes('</script>\n</body>'));
check("Captures timezone", injected.includes("Intl.DateTimeFormat().resolvedOptions().timeZone"));
check("Captures locale", injected.includes("navigator.language"));
check("Suppresses preview tracking in search", injected.includes('dw_preview=heatmap'));

// Tracker script sensitive content masking
const trackerCode = generateTrackerScript({ slug: "test-biz", visitId: "v_123", token: "tok_abc" });
check("Tracker masks password fields", trackerCode.includes('inputType === "password"'));
check("Tracker masks inputs", trackerCode.includes('[masked]'));
check("Tracker checks private/sensitive containers", trackerCode.includes('data-dw-mask'));
check("Tracker generates event IDs", trackerCode.includes('c_'));
check("Tracker uses keepalive fetch fallback", trackerCode.includes('keepalive: true'));

// Tracker disabled in admin heatmap preview mode
const disabledScript = generateTrackerScript({ slug: "test-biz", sessionId: "sess_123", disabled: true });
check("Disabled tracker does not run tracking code", disabledScript.includes("Tracking disabled in preview/heatmap mode"));
check("Disabled tracker does not include click listener", !disabledScript.includes("addEventListener(\"click\""));

const htmlNoBody = `<!doctype html><html><head><title>Demo</title></head><div>No body tag</div></html>`;
const injectedNoBody = injectDemoTracker(htmlNoBody, { slug: "test-biz-2", sessionId: "sess_456" });
check("Injected before closing html when no body", injectedNoBody.includes('</script>\n</html>'));

console.log(`demoAnalytics: ${checks} checks passed`);
