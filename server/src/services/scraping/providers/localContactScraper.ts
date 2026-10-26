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

// Standard international & local phone regex patterns (including US area codes with brackets/dots/dashes)
const PHONE_REGEX =
  /(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}|(?:\+?233|0)[235][0-9]{8}|\+?[1-9]\d{1,14}(?:[\s.-]?\d{2,4}){2,4}/g;

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

/**
 * Resilient fetch with automatic fallback:
 * - Attempts the given URL with a bounded timeout.
 * - If http fails (e.g. connection timeout or refused), falls back to https.
 * - If non-www fails, falls back to www.
 */
async function fetchPageWithFallback(url: string, timeoutMs: number): Promise<Response | null> {
  const tryFetch = async (target: string): Promise<Response | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(target, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
        signal: controller.signal,
        redirect: "follow",
      });
      if (resp.ok) return resp;
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // 1. Try the exact requested URL
  let resp = await tryFetch(url);
  if (resp) return resp;

  // 2. If http failed or timed out, try https
  if (/^http:\/\//i.test(url)) {
    const httpsUrl = url.replace(/^http:\/\//i, "https://");
    resp = await tryFetch(httpsUrl);
    if (resp) return resp;
  }

  // 3. If non-www failed or timed out, try with www.
  try {
    const u = new URL(url);
    if (!u.hostname.startsWith("www.")) {
      u.hostname = `www.${u.hostname}`;
      resp = await tryFetch(u.href);
      if (resp) return resp;
    }
  } catch {
    // Ignore URL formatting errors
  }

  return null;
}

export async function scrapeContactsLocally(
  rawStartUrl: string,
  options: { maxPages?: number; timeoutMs?: number } = {},
): Promise<ContactExtractionResult> {
  const startedAt = Date.now();
  const maxPages = Math.min(options.maxPages ?? 4, 10);
  const timeoutMs = options.timeoutMs ?? 7_000;

  // Clean enclosing quotes, brackets, and trailing commas/periods
  let startUrl = rawStartUrl
    .trim()
    .replace(/^[<("'[]+/, "")
    .replace(/[>)"'\]]+$/, "")
    .replace(/[,;:!?]+$/, "")
    .trim();

  if (!/^https?:\/\//i.test(startUrl)) {
    startUrl = `https://${startUrl.replace(/^\/+/, "")}`;
  }

  const safety = isSafeUrl(startUrl);
  if (!safety.safe || !safety.url) {
    throw new Error(`Unsafe or invalid target URL: ${safety.reason}`);
  }

  const domain = safety.url.hostname.replace(/^www\./i, "").toLowerCase();

  const visited = new Set<string>();
  const queue: string[] = [safety.url.href];

  const emails = new Set<string>();
  const phones = new Set<string>();
  const phonesUncertain = new Set<string>();
  const socialLinks: ContactExtractionResult["socialLinks"] = {};
  let siteTitle = "";
  let companyName = "";
  let description = "";

  const contactLinkPattern = /(contact|about|touch|reach|location|help|support)/i;

  while (queue.length > 0 && visited.size < maxPages) {
    const currentUrl = queue.shift()!;
    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    try {
      const resp = await fetchPageWithFallback(currentUrl, timeoutMs);
      if (!resp) continue;

      const finalUrl = resp.url || currentUrl;
      const html = await resp.text();
      const $ = cheerio.load(html);

      // Extract site title, company name and description (usually on first/home page)
      if (!siteTitle) {
        const ogSiteName = $('meta[property="og:site_name"]').attr("content")?.trim();
        const ogTitle = $('meta[property="og:title"]').attr("content")?.trim();
        const pageTitle = $("title").text().trim();
        siteTitle = ogSiteName || ogTitle || pageTitle || "";
        if (!companyName) {
          companyName = ogSiteName || (siteTitle ? siteTitle.split(/[|\-•–—]/)[0].trim() : "");
        }
      }
      if (!description) {
        description = $('meta[name="description"]').attr("content")?.trim() || $('meta[property="og:description"]').attr("content")?.trim() || "";
      }

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

      // 2. Parse phone numbers: tel: links first (highest fidelity)
      $('a[href^="tel:"]').each((_, el) => {
        const href = $(el).attr("href") || "";
        const tel = href.replace(/^tel:/i, "").split("?")[0]?.trim();
        const digits = tel.replace(/\D/g, "");
        if (digits.length >= 7 && digits.length <= 15) {
          phones.add(tel);
        }
      });

      // Also parse formatted phones in body text (require formatting or + prefix to avoid numeric IDs)
      const matchedPhones = bodyText.match(PHONE_REGEX) || [];
      for (const phone of matchedPhones) {
        const cleaned = phone.replace(/[^\d+]/g, "");
        const hasFormatting = /[\s().-]/.test(phone) || phone.startsWith("+");
        if (hasFormatting && cleaned.length >= 8 && cleaned.length <= 15 && !/^(\d)\1+$/.test(cleaned)) {
          phones.add(phone.trim());
        }
      }

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

        // Queue internal contact/about links (domain matching across scheme/redirects)
        try {
          const resolved = new URL(href, finalUrl);
          const resolvedDomain = resolved.hostname.replace(/^www\./i, "").toLowerCase();
          if (
            resolvedDomain === domain &&
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

      // Early exit if primary contact details (email and phone) are already found on homepage
      if (emails.size > 0 && phones.size > 0) {
        break;
      }
    } catch {
      // Continue to next page if one fails
    }
  }

  return {
    domain,
    originalStartUrl: startUrl,
    companyName: companyName || domain,
    title: siteTitle,
    description,
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
