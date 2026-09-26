/**
 * Verification of demo analytics: user agent parsing, geo resolution,
 * tracker script injection, and analytics aggregation logic.
 *
 *   npx tsx checks/demoAnalytics.ts
 */
import assert from "node:assert/strict";
import { parseUserAgent } from "../src/lib/deviceParser.js";
import { countryName, countryFlag, isPrivateOrLocalIp, resolveIpLocation } from "../src/lib/demoGeo.js";
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

/* ------------------------------------ Geo and IP Location -- */

equal("Ghana country name", countryName("GH"), "Ghana");
equal("US country name", countryName("US"), "United States");
equal("UK country name", countryName("GB"), "United Kingdom");
equal("Unknown code returns null", countryName("ZZ"), null);
equal("Null code returns null", countryName(null), null);

equal("Ghana flag", countryFlag("GH"), "🇬🇭");
equal("US flag", countryFlag("US"), "🇺🇸");
equal("UK flag", countryFlag("GB"), "🇬🇧");
equal("Local flag", countryFlag("LOCAL"), "🏠");
equal("Invalid flag fallback", countryFlag(null), "🌐");

check("Localhost is private IP", isPrivateOrLocalIp("127.0.0.1"));
check("IPv6 loopback is private", isPrivateOrLocalIp("::1"));
check("192.168.1.100 is private", isPrivateOrLocalIp("192.168.1.100"));
check("10.0.0.5 is private", isPrivateOrLocalIp("10.0.0.5"));
check("8.8.8.8 is public", !isPrivateOrLocalIp("8.8.8.8"));

const localLocation = resolveIpLocation("127.0.0.1");
equal("Local IP resolved to Local Development", localLocation.countryName, "Local Development");
equal("Local IP flag", localLocation.flag, "🏠");
equal("Local flag isLocal", localLocation.isLocal, true);

const ghLocation = resolveIpLocation("102.176.0.1");
equal("Ghana IP resolves to GH", ghLocation.country, "GH");
equal("Ghana IP name", ghLocation.countryName, "Ghana");
equal("Ghana IP flag", ghLocation.flag, "🇬🇭");

/* ------------------------------------ Tracker Script Injection -- */

const sampleHtml = `<!doctype html><html><head><title>Demo</title></head><body><h1>Hello</h1></body></html>`;
const injected = injectDemoTracker(sampleHtml, { slug: "test-biz", sessionId: "sess_123" });
check("Tracker script is injected", injected.includes('id="dw-demo-tracker"'));
check("Slug is embedded", injected.includes('"test-biz"'));
check("Session ID is embedded", injected.includes('"sess_123"'));
check("Injected before closing body", injected.includes('</script>\n</body>'));

const htmlNoBody = `<!doctype html><html><head><title>Demo</title></head><div>No body tag</div></html>`;
const injectedNoBody = injectDemoTracker(htmlNoBody, { slug: "test-biz-2", sessionId: "sess_456" });
check("Injected before closing html when no body", injectedNoBody.includes('</script>\n</html>'));

console.log(`demoAnalytics: ${checks} checks passed`);
