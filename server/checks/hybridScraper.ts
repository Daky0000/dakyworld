import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { isSafeUrl } from "../src/services/scraping/safety/ssrf.js";
import { captureLocalScreenshots, closeSharedBrowser } from "../src/services/scraping/providers/localScreenshot.js";
import { scrapeContactsLocally } from "../src/services/scraping/providers/localContactScraper.js";
import { runHybridScreenshot } from "../src/services/scraping/hybridScreenshotService.js";
import { downloadScreenshot } from "../src/services/apifyScreenshot.js";

// --- 1. SSRF and Safety Tests ---
assert.equal(isSafeUrl("http://localhost:3000").safe, false, "Should block localhost");
assert.equal(isSafeUrl("http://127.0.0.1:8080").safe, false, "Should block 127.0.0.1");
assert.equal(isSafeUrl("http://169.254.169.254/latest/meta-data").safe, false, "Should block AWS metadata");
assert.equal(isSafeUrl("http://10.0.0.1/admin").safe, false, "Should block RFC1918 10.x");
assert.equal(isSafeUrl("http://192.168.1.1").safe, false, "Should block RFC1918 192.168.x");
assert.equal(isSafeUrl("ftp://example.com").safe, false, "Should block FTP protocol");
assert.equal(isSafeUrl("https://example.com").safe, true, "Should allow public HTTPS");

console.log("✓ SSRF safety checks passed");

// Enable loopback for the local Express test fixture
process.env.DEV_ALLOW_LOOPBACK = "true";

// --- 2. Setup Local Test Server Fixture ---
const app = express();

app.get("/", (_req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head><title>Local Business Test</title></head>
      <body style="background: #f0fdf4; font-family: sans-serif; padding: 40px;">
        <h1 style="color: #166534;">Dakyworld Local Fixture</h1>
        <p>Email us at <a href="mailto:info@dakyfixture.com">info@dakyfixture.com</a></p>
        <p>Call our office: +233241234567</p>
        <nav>
          <a href="/contact">Contact Page</a> |
          <a href="/about">About Us</a>
        </nav>
      </body>
    </html>
  `);
});

app.get("/contact", (_req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head><title>Contact Us - Local Fixture</title></head>
      <body>
        <h2>Get in touch</h2>
        <p>Support: support@dakyfixture.com</p>
        <footer>
          <a href="https://linkedin.com/company/dakyfixture">LinkedIn Profile</a>
          <a href="https://facebook.com/dakyfixture">Facebook Page</a>
        </footer>
      </body>
    </html>
  `);
});

app.get("/blocked", (_req, res) => {
  res.status(403).send(`
    <!DOCTYPE html>
    <html>
      <head><title>Attention Required! | Cloudflare</title></head>
      <body><h1>403 Forbidden - Security Challenge</h1></body>
    </html>
  `);
});

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

try {
  // --- 3. Test Local Contact Extraction ---
  console.log("Testing Cheerio-based contact extraction...");
  const contact = await scrapeContactsLocally(base, { maxPages: 3 });
  assert.equal(contact.emails.includes("info@dakyfixture.com"), true, "Should extract main email");
  assert.equal(contact.emails.includes("support@dakyfixture.com"), true, "Should crawl and extract contact page email");
  assert.equal(contact.phones.some((p) => p.includes("233241234567")), true, "Should extract phone");
  assert.equal(contact.socialLinks.linkedin, "https://linkedin.com/company/dakyfixture");
  assert.equal(contact.socialLinks.facebook, "https://facebook.com/dakyfixture");
  assert.equal(contact.provenance.costUsd, 0, "Cost should be exactly $0");
  console.log("✓ Contact extraction passed ($0 cost)");

  // --- 4. Test Local Playwright + Sharp Screenshots ---
  console.log("Testing Playwright + Sharp local screenshot engine...");
  const capture = await captureLocalScreenshots({
    urls: [{ id: "test-home", url: base }],
    viewport: { width: 1280, height: 800 },
    fullPage: false,
    delayMs: 500,
    maxWidth: 1024,
    maxHeight: 1200,
  });

  assert.equal(capture.browserError, null, "Browser should start without error");
  assert.equal(capture.rows.size, 1, "Should have 1 row");
  const homeRow = capture.rows.get("test-home")!;
  assert.equal(homeRow.success, true, "Screenshot should succeed");
  assert.equal(homeRow.width, 1024, "Image width should be resized to maxWidth 1024");
  assert.equal(homeRow.format, "png", "Format should be PNG");
  assert.equal(homeRow.screenshotUrl?.startsWith("data:image/png;base64,"), true, "Should be Data URI");

  // Verify downloadScreenshot parses data: URI instantly
  const downloaded = await downloadScreenshot(homeRow.screenshotUrl!);
  assert.equal(downloaded.ok, true, "Should decode Data URI");
  if (downloaded.ok) {
    assert.equal(downloaded.bytes.byteLength > 1000, true, "Should contain non-empty image bytes");
  }
  console.log("✓ Local screenshot capture passed ($0 cost)");

  // --- 5. Test Bot Detection / Cloudflare Shield Handling ---
  console.log("Testing Cloudflare / Bot detection on protected pages...");
  const blockedCapture = await captureLocalScreenshots({
    urls: [{ id: "test-blocked", url: `${base}/blocked` }],
    viewport: { width: 1280, height: 800 },
    fullPage: false,
    delayMs: 200,
  });
  const blockedRow = blockedCapture.rows.get("test-blocked")!;
  assert.equal(blockedRow.error?.code, "BOT_BLOCKED", "Should identify bot challenge");
  assert.equal(blockedCapture.blockedCount, 1, "Should flag blockedCount for fallback");
  console.log("✓ Cloudflare / Bot detection accurately classified");

  // --- 6. Test Hybrid Router ---
  console.log("Testing hybrid screenshot router...");
  const hybridResult = await runHybridScreenshot(
    {
      urls: [{ id: "h1", url: base }],
      viewport: { width: 1280, height: 800 },
      fullPage: false,
      delayMs: 200,
      maxWidth: 1024,
    },
    { waitMs: 10000 },
  );

  assert.equal(hybridResult.ok, true);
  assert.equal(hybridResult.provider, "playwright", "Should resolve via free Playwright provider");
  assert.equal(hybridResult.costUsd, 0, "Apify cost should be $0.00");
  console.log("✓ Hybrid router: local-first execution succeeded ($0 Apify spend)");

  console.log("\n=======================================================");
  console.log("ALL HYBRID SCRAPER ACCEPTANCE CHECKS PASSED SUCCESSFULLY!");
  console.log("=======================================================");
} finally {
  await closeSharedBrowser().catch(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
