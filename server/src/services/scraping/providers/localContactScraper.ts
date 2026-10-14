import * as cheerio from "cheerio";
import { isSafeUrl } from "../safety/ssrf.js";
import type { ContactExtractionResult } from "../types.js";

/**
 * Free Local Contact Scraper (Cheerio-based).
 *
 * Drops in to replace `vdrmota/contact-info-scraper` runs for ordinary websites.
 * Bounded to 5 pages per site, fast, and consumes near-zero CPU/RAM.
 */

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Standard international & local phone regex patterns
const PHONE_REGEX = /(?:\+?233|0)[235][0-9]{8}|\+?[1-9]\d{1,14}(?:[\s.-]?\d{2,4}){2,4}/g;

const DISALLOWED_EMAIL_DOMAINS = new Set([
  "example.com",
  "domain.com",
  "yourdomain.com",
  "sentry.io",
  "wixpress.com",
  "wordpress.org",
  "schema.org",
  "cloudflare.com",
]);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export async function scrapeContactsLocally(
  rawStartUrl: string,
  options: { maxPages?: number; timeoutMs?: number } = {},
): Promise<ContactExtractionResult> {
  const startedAt = Date.now();
  const maxPages = Math.min(options.maxPages ?? 5, 10);
  const timeoutMs = options.timeoutMs ?? 15_000;

  let startUrl = rawStartUrl.trim();
  if (!/^https?:\/\//i.test(startUrl)) {
    startUrl = `https://${startUrl}`;
  }

  const safety = isSafeUrl(startUrl);
  if (!safety.safe || !safety.url) {
    throw new Error(`Unsafe or invalid target URL: ${safety.reason}`);
  }

  const origin = safety.url.origin;
  const domain = safety.url.hostname.replace(/^www\./i, "");

  const visited = new Set<string>();
  const queue: string[] = [safety.url.href];

  const emails = new Set<string>();
  const phones = new Set<string>();
  const phonesUncertain = new Set<string>();
  const socialLinks: ContactExtractionResult["socialLinks"] = {};

  const contactLinkPattern = /(contact|about|touch|reach|location|help|support)/i;

  while (queue.length > 0 && visited.size < maxPages) {
    const currentUrl = queue.shift()!;
    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const resp = await fetch(currentUrl, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      if (!resp.ok) continue;
      const html = await resp.text();
      const $ = cheerio.load(html);

      // 1. Parse text for emails
      const bodyText = $("body").text();
      const matchedEmails = bodyText.match(EMAIL_REGEX) || [];
      for (const email of matchedEmails) {
        const clean = email.toLowerCase().trim();
        const emailDomain = clean.split("@")[1];
        if (emailDomain && !DISALLOWED_EMAIL_DOMAINS.has(emailDomain) && !clean.endsWith(".png") && !clean.endsWith(".jpg")) {
          emails.add(clean);
        }
      }

      // Also check mailto: links
      $('a[href^="mailto:"]').each((_, el) => {
        const href = $(el).attr("href") || "";
        const email = href.replace(/^mailto:/i, "").split("?")[0]?.trim().toLowerCase();
        if (email && email.includes("@")) {
          emails.add(email);
        }
      });

      // 2. Parse text for phone numbers
      const matchedPhones = bodyText.match(PHONE_REGEX) || [];
      for (const phone of matchedPhones) {
        const cleaned = phone.replace(/[^\d+]/g, "");
        if (cleaned.length >= 8 && cleaned.length <= 16) {
          phones.add(phone.trim());
        }
      }

      // Also check tel: links
      $('a[href^="tel:"]').each((_, el) => {
        const href = $(el).attr("href") || "";
        const tel = href.replace(/^tel:/i, "").split("?")[0]?.trim();
        if (tel) phones.add(tel);
      });

      // 3. Extract social media links
      $("a[href]").each((_, el) => {
        const href = $(el).attr("href") || "";
        if (/linkedin\.com\/(?:company|in)\//i.test(href) && !socialLinks.linkedin) {
          socialLinks.linkedin = href;
        } else if (/facebook\.com\//i.test(href) && !/sharer/i.test(href) && !socialLinks.facebook) {
          socialLinks.facebook = href;
        } else if (/instagram\.com\//i.test(href) && !socialLinks.instagram) {
          socialLinks.instagram = href;
        } else if (/(?:twitter\.com|x\.com)\//i.test(href) && !socialLinks.twitter) {
          socialLinks.twitter = href;
        } else if (/youtube\.com\//i.test(href) && !socialLinks.youtube) {
          socialLinks.youtube = href;
        }

        // Queue internal contact/about links
        try {
          const resolved = new URL(href, currentUrl);
          if (
            resolved.origin === origin &&
            !visited.has(resolved.href) &&
            contactLinkPattern.test(resolved.pathname) &&
            !/\.(png|jpg|jpeg|gif|svg|pdf|zip|css|js)$/i.test(resolved.pathname)
          ) {
            if (!queue.includes(resolved.href)) {
              queue.push(resolved.href);
            }
          }
        } catch {
          // Ignore invalid link URLs
        }
      });
    } catch {
      // Continue to next page if one fails
    }
  }

  return {
    domain,
    originalStartUrl: startUrl,
    emails: Array.from(emails),
    phones: Array.from(phones),
    phonesUncertain: Array.from(phonesUncertain),
    socialLinks,
    provenance: {
      provider: "cheerio",
      sourceUrl: startUrl,
      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      costUsd: 0,
    },
  };
}
