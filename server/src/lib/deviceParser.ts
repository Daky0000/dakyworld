/**
 * Device, browser, and operating system parsing from User-Agent strings.
 *
 * Lightweight, zero-dependency, and deterministic. Used by demo analytics
 * to understand what devices prospects use to view their custom demo pages.
 */

export interface ParsedClientDevice {
  deviceType: "desktop" | "mobile" | "tablet" | "bot";
  browser: string;
  os: string;
  isBot: boolean;
}

const BOT_PATTERNS = [
  /Googlebot/i,
  /bingbot/i,
  /Yahoo! Slurp/i,
  /DuckDuckBot/i,
  /Baiduspider/i,
  /YandexBot/i,
  /facebookexternalhit/i,
  /Twitterbot/i,
  /LinkedInBot/i,
  /Slackbot/i,
  /WhatsApp/i,
  /TelegramBot/i,
  /Applebot/i,
  /crawler/i,
  /spider/i,
  /bot\b/i,
];

export function parseUserAgent(ua: string | null | undefined): ParsedClientDevice {
  if (!ua || typeof ua !== "string") {
    return {
      deviceType: "desktop",
      browser: "Unknown",
      os: "Unknown",
      isBot: false,
    };
  }

  const raw = ua.trim();

  // 1. Detect bots / web crawlers
  const isBot = BOT_PATTERNS.some((pattern) => pattern.test(raw));
  if (isBot) {
    let botName = "Web Crawler";
    if (/Googlebot/i.test(raw)) botName = "Googlebot";
    else if (/bingbot/i.test(raw)) botName = "Bingbot";
    else if (/facebookexternalhit/i.test(raw)) botName = "Facebook Bot";
    else if (/Twitterbot/i.test(raw)) botName = "Twitter Bot";
    else if (/LinkedInBot/i.test(raw)) botName = "LinkedIn Bot";
    else if (/Slackbot/i.test(raw)) botName = "Slackbot";
    else if (/WhatsApp/i.test(raw)) botName = "WhatsApp Preview";
    else if (/Applebot/i.test(raw)) botName = "Applebot";

    return {
      deviceType: "bot",
      browser: botName,
      os: "Bot",
      isBot: true,
    };
  }

  // 2. Detect Operating System
  let os = "Unknown";
  if (/iPhone/i.test(raw)) {
    os = "iOS";
  } else if (/iPad/i.test(raw)) {
    os = "iPadOS";
  } else if (/Android/i.test(raw)) {
    os = "Android";
  } else if (/Windows NT 10/i.test(raw)) {
    os = "Windows 10/11";
  } else if (/Windows NT 6\.3/i.test(raw)) {
    os = "Windows 8.1";
  } else if (/Windows NT 6\.1/i.test(raw)) {
    os = "Windows 7";
  } else if (/Windows NT/i.test(raw)) {
    os = "Windows";
  } else if (/Macintosh|Mac OS X/i.test(raw)) {
    // Note: iPads with desktop UA can look like Mac OS X, but have touch points on client
    os = "macOS";
  } else if (/CrOS/i.test(raw)) {
    os = "ChromeOS";
  } else if (/Linux/i.test(raw)) {
    os = "Linux";
  }

  // 3. Detect Device Type
  let deviceType: "desktop" | "mobile" | "tablet" = "desktop";
  if (/iPad|Tablet/i.test(raw) || (/Android/i.test(raw) && !/Mobile/i.test(raw))) {
    deviceType = "tablet";
  } else if (/iPhone|iPod|Mobile/i.test(raw) || /Android.*Mobile/i.test(raw)) {
    deviceType = "mobile";
  } else {
    deviceType = "desktop";
  }

  // 4. Detect Browser
  let browser = "Other";
  if (/Edg\//i.test(raw)) {
    browser = "Edge";
  } else if (/SamsungBrowser/i.test(raw)) {
    browser = "Samsung Internet";
  } else if (/OPR\/|Opera/i.test(raw)) {
    browser = "Opera";
  } else if (/UCBrowser/i.test(raw)) {
    browser = "UC Browser";
  } else if (/Chrome\/|CriOS\//i.test(raw)) {
    browser = "Chrome";
  } else if (/Firefox\/|FxiOS\//i.test(raw)) {
    browser = "Firefox";
  } else if (/Safari/i.test(raw) && !/Chrome|CriOS|Android/i.test(raw)) {
    browser = "Safari";
  }

  return {
    deviceType,
    browser,
    os,
    isBot: false,
  };
}
