/**
 * Verification of demo analytics: user agent parsing, geo resolution,
 * multi-tier location detection, IP sanitization, tracker script injection,
 * and preview isolation.
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
  resolveIpLocation,
  resolveFromTimezone,
  resolveFromLocale,
  extractClientIp,
  extractGeoHints,
} from "../src/lib/demoGeo.js";
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

// Bot detection
const googleBot = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const botParsed = parseUserAgent(googleBot);
equal("Googlebot detected", botParsed.deviceType, "bot");
equal("Googlebot isBot", botParsed.isBot, true);
equal("Googlebot name", botParsed.browser, "Googlebot");

/* ------------------------------------ IP Sanitization and Network Detection -- */

equal("Clean IPv4 with port", cleanIp("102.176.0.1:44321"), "102.176.0.1");
equal("Clean bracketed IPv6 with port", cleanIp("[2001:db8::1]:8080"), "2001:db8::1");
equal("Clean ::ffff: prefix", cleanIp("::ffff:192.168.1.5"), "192.168.1.5");
equal("Clean ::ffff: with port", cleanIp("::ffff:127.0.0.1:3000"), "127.0.0.1");
equal("Clean plain IP", cleanIp("8.8.8.8"), "8.8.8.8");

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

/* ------------------------------------ Geo and IP Location -- */

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

// Public IP lookup (including when port is attached)
const ghLocation = resolveIpLocation("102.176.0.1:44321");
equal("Ghana IP with port resolves to GH", ghLocation.country, "GH");
equal("Ghana IP name", ghLocation.countryName, "Ghana");
equal("Ghana IP flag", ghLocation.flag, "🇬🇭");
equal("Ghana IP capital city default", ghLocation.city, "Accra");
equal("Ghana IP is not local", ghLocation.isLocal, false);

const usLocation = resolveIpLocation("8.8.8.8:8080");
equal("US IP resolves to US", usLocation.country, "US");
equal("US IP name", usLocation.countryName, "United States");
equal("US IP flag", usLocation.flag, "🇺🇸");

// Local development fallback
const plainLocal = resolveIpLocation("127.0.0.1");
equal("Plain local IP country", plainLocal.country, "LOCAL");
equal("Plain local IP name", plainLocal.countryName, "Local Development");
equal("Plain local IP flag", plainLocal.flag, "🏠");
check("Plain local IP isLocal", plainLocal.isLocal);

// Timezone and locale-assisted resolution
const tzGh = resolveFromTimezone("Africa/Accra");
check("Timezone Africa/Accra resolves", tzGh !== null);
equal("Timezone Africa/Accra country", tzGh?.country, "GH");
equal("Timezone Africa/Accra city", tzGh?.city, "Accra");
equal("Timezone Africa/Accra flag", tzGh?.flag, "🇬🇭");

const tzNy = resolveFromTimezone("America/New_York");
equal("Timezone America/New_York country", tzNy?.country, "US");
equal("Timezone America/New_York city", tzNy?.city, "New York");

const tzLondon = resolveFromTimezone("Europe/London");
equal("Timezone Europe/London country", tzLondon?.country, "GB");
equal("Timezone Europe/London city", tzLondon?.city, "London");

const locGh = resolveFromLocale("en-GH");
equal("Locale en-GH country", locGh?.country, "GH");
equal("Locale en-GH name", locGh?.countryName, "Ghana");

// Local development enriched with visitor timezone (e.g. testing locally in Accra)
const localWithTz = resolveIpLocation("127.0.0.1:3000", { timezone: "Africa/Accra" });
equal("Local with TZ country", localWithTz.country, "GH");
equal("Local with TZ countryName", localWithTz.countryName, "Ghana");
equal("Local with TZ city", localWithTz.city, "Accra");
equal("Local with TZ flag", localWithTz.flag, "🇬🇭");
check("Local with TZ preserves isLocal flag", localWithTz.isLocal);

// CDN edge header resolution
const cdnLocation = resolveIpLocation("1.2.3.4", { hintCountry: "GH", hintCity: "Kumasi" });
equal("CDN hint country wins", cdnLocation.country, "GH");
equal("CDN hint city wins", cdnLocation.city, "Kumasi");
equal("CDN hint flag", cdnLocation.flag, "🇬🇭");

// Edge header extraction
const mockReq = {
  headers: {
    "cf-connecting-ip": "102.176.0.1:54321",
    "cf-ipcountry": "GH",
    "cf-ipcity": "Accra",
    "x-forwarded-for": "10.0.0.1, 102.176.0.1",
  },
  ip: "10.0.0.1",
};
equal("extractClientIp takes cf-connecting-ip without port", extractClientIp(mockReq), "102.176.0.1");
const hints = extractGeoHints(mockReq);
equal("extractGeoHints country", hints.country, "GH");
equal("extractGeoHints city", hints.city, "Accra");

/* ------------------------------------ Tracker Script Injection & Preview Isolation -- */

const sampleHtml = `<!doctype html><html><head><title>Demo</title></head><body><h1>Hello</h1></body></html>`;
const injected = injectDemoTracker(sampleHtml, { slug: "test-biz", sessionId: "sess_123" });
check("Tracker script is injected", injected.includes('id="dw-demo-tracker"'));
check("Slug is embedded", injected.includes('"test-biz"'));
check("Session ID is embedded", injected.includes('"sess_123"'));
check("Injected before closing body", injected.includes('</script>\n</body>'));
check("Captures timezone", injected.includes("Intl.DateTimeFormat().resolvedOptions().timeZone"));
check("Captures locale", injected.includes("navigator.language"));
check("Suppresses preview tracking in search", injected.includes('dw_preview=heatmap'));

// Tracker disabled in admin heatmap preview mode
const disabledScript = generateTrackerScript({ slug: "test-biz", sessionId: "sess_123", disabled: true });
check("Disabled tracker does not run tracking code", disabledScript.includes("Tracking disabled in preview/heatmap mode"));
check("Disabled tracker does not include click listener", !disabledScript.includes("addEventListener(\"click\""));

const htmlNoBody = `<!doctype html><html><head><title>Demo</title></head><div>No body tag</div></html>`;
const injectedNoBody = injectDemoTracker(htmlNoBody, { slug: "test-biz-2", sessionId: "sess_456" });
check("Injected before closing html when no body", injectedNoBody.includes('</script>\n</html>'));

console.log(`demoAnalytics: ${checks} checks passed`);
