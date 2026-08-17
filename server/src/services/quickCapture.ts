/**
 * Paste something, get leads.
 *
 * Capturing one company used to mean: open Capture, add a source, pick a
 * template, hand-edit `startUrls` inside a JSON box, save it as a permanent
 * source, then run it. That is a configuration ritual, and it is the reason
 * nobody but the Owner captures anything. An employee with a URL should be
 * able to paste the URL.
 *
 * So this classifies whatever was pasted and decides what to do with it. The
 * hard-won part is that every network has its own idea of what an input is,
 * and getting it wrong fails silently — an undeclared key is dropped rather
 * than rejected. All of the below was read off the live actor schemas rather
 * than assumed:
 *
 *  - **Instagram wants usernames, not URLs.** `apify/instagram-profile-scraper`
 *    declares `usernames: array`, so `instagram.com/kessbenhotel` has to become
 *    `kessbenhotel` on the way in.
 *  - **Facebook wants page URLs and says so explicitly**: "Only works on
 *    facebook pages, not personal profiles (not even public ones)." A
 *    `profile.php?id=` link is rejected here rather than burning a paid run.
 *  - **LinkedIn wants plain company URLs** in `companies`, and only the
 *    no-cookie actor is usable — the alternatives want a session cookie pasted
 *    in or a monthly subscription.
 *  - **A Maps link is turned back into a search phrase.** The place name is
 *    already in the URL path, and `searchStringsArray` is an input this app has
 *    used against those actors for months. Inventing a `startUrls` for them
 *    would be a guess.
 *
 * Anything that isn't a link at all — rows off a spreadsheet, a list someone
 * typed, a block of text with emails in it — is not scraped. It goes to the
 * import analyst that already exists, which is better at reading a mess than
 * any classifier here could be.
 */

export type CaptureKind =
  | "WEBSITE"
  | "MAPS_SEARCH"
  | "LINKEDIN_COMPANY"
  | "FACEBOOK_PAGE"
  | "INSTAGRAM"
  | "ROWS"
  | "REJECTED";

export interface CaptureItem {
  kind: CaptureKind;
  /** What to hand the actor: a URL, a username, or a search phrase. */
  value: string;
  /** What the person actually typed, so the UI can show it back to them. */
  raw: string;
  /** Set on REJECTED — a sentence explaining why, in plain language. */
  reason?: string;
}

export interface CapturePlan {
  items: CaptureItem[];
  /** Set when the paste is tabular or prose rather than links. */
  rows: string | null;
}

const SOCIAL_HOSTS = /(^|\.)(linkedin\.com|instagram\.com|facebook\.com|fb\.com|m\.facebook\.com)$/i;
const MAPS_HOSTS = /(^|\.)(google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl)$/i;

/** Instagram paths that are content, not an account. */
const IG_RESERVED = new Set(["p", "reel", "reels", "explore", "stories", "tv", "s", "accounts", "direct"]);

function asUrl(token: string): URL | null {
  const trimmed = token.trim().replace(/[),.;]+$/, "");
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : /^[\w-]+(\.[\w-]+)+(\/|$)/.test(trimmed)
      ? `https://${trimmed}`
      : null;
  if (!withScheme) return null;
  try {
    const url = new URL(withScheme);
    return url.hostname ? url : null;
  } catch {
    return null;
  }
}

function segments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

/**
 * Google puts the place name in the path (`/maps/place/Kessben+Hotel/@...`),
 * so a pasted Maps link becomes the search phrase it came from. A shortened
 * `maps.app.goo.gl` link carries nothing readable, so it is rejected with an
 * instruction rather than silently searching for nothing.
 */
function mapsPhrase(url: URL): CaptureItem | null {
  if (/goo\.gl$/i.test(url.hostname)) {
    return {
      kind: "REJECTED",
      value: "",
      raw: url.toString(),
      reason: "Shortened Maps links don't say what they point at. Open it, then paste the full link — or just type what you're looking for, like “dental clinics in Kumasi”.",
    };
  }
  const parts = segments(url);
  const at = parts.indexOf("place");
  const named = at >= 0 ? parts[at + 1] : undefined;
  const query = url.searchParams.get("q") ?? url.searchParams.get("query");
  const phrase = decodeURIComponent(named ?? query ?? "").replace(/\+/g, " ").trim();
  if (!phrase) return null;
  return { kind: "MAPS_SEARCH", value: phrase, raw: url.toString() };
}

function classifyUrl(url: URL): CaptureItem {
  const raw = url.toString();
  const host = url.hostname.replace(/^www\./i, "");
  const parts = segments(url);

  if (MAPS_HOSTS.test(host) && (/^maps\./i.test(url.hostname) || parts[0] === "maps" || /goo\.gl$/i.test(host))) {
    return mapsPhrase(url) ?? { kind: "REJECTED", value: "", raw, reason: "That Maps link doesn't name a place. Type what you're looking for instead." };
  }

  if (/linkedin\.com$/i.test(host)) {
    if (parts[0] === "company" && parts[1]) {
      // The actor wants the plain company URL, canonicalised.
      return { kind: "LINKEDIN_COMPANY", value: `https://www.linkedin.com/company/${parts[1]}`, raw };
    }
    if (parts[0] === "in") {
      return {
        kind: "REJECTED",
        value: "",
        raw,
        reason: "That's a person's LinkedIn, not a company page. Open their company from their profile and paste that instead.",
      };
    }
    return { kind: "REJECTED", value: "", raw, reason: "Only LinkedIn company pages can be captured — the link should look like linkedin.com/company/name." };
  }

  if (/(facebook\.com|fb\.com)$/i.test(host)) {
    if (parts[0] === "profile.php" || url.pathname.startsWith("/profile.php")) {
      return {
        kind: "REJECTED",
        value: "",
        raw,
        reason: "Facebook only allows business Pages to be read, not personal profiles. If the business has a Page, paste that.",
      };
    }
    if (!parts[0]) return { kind: "REJECTED", value: "", raw, reason: "That Facebook link doesn't point at a Page." };
    return { kind: "FACEBOOK_PAGE", value: `https://www.facebook.com/${parts[0]}/`, raw };
  }

  if (/instagram\.com$/i.test(host)) {
    const handle = parts[0]?.replace(/^@/, "");
    if (!handle || IG_RESERVED.has(handle.toLowerCase())) {
      return {
        kind: "REJECTED",
        value: "",
        raw,
        reason: "That's an Instagram post, not an account. Open the account and paste its link — instagram.com/theirname.",
      };
    }
    // This actor takes usernames, not URLs.
    return { kind: "INSTAGRAM", value: handle, raw };
  }

  if (SOCIAL_HOSTS.test(host)) {
    return { kind: "REJECTED", value: "", raw, reason: "That social link isn't one we can read." };
  }

  return { kind: "WEBSITE", value: raw, raw };
}

/**
 * True when the paste is data rather than links: a spreadsheet selection, a
 * comma-separated list of fields, or prose with contact details in it. Sent to
 * the import analyst instead of a scraper.
 */
function looksTabular(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  if (lines.some((line) => line.includes("\t"))) return true;

  // A single line with an email or a phone and no URL is somebody's notes.
  const urlish = lines.filter((line) => asUrl(line.split(/[\s,]+/)[0] ?? "")).length;
  if (urlish >= lines.length * 0.5) return false;

  const hasContact = /[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s()-]{7,}/.test(text);
  const commaRows = lines.filter((line) => (line.match(/,/g) ?? []).length >= 2).length;
  return hasContact || commaRows >= Math.max(2, lines.length * 0.6);
}

/** Splits a paste into what to scrape and what to hand the import analyst. */
export function planCapture(text: string): CapturePlan {
  const cleaned = (text ?? "").trim();
  if (!cleaned) return { items: [], rows: null };

  if (looksTabular(cleaned)) return { items: [], rows: cleaned };

  const seen = new Set<string>();
  const items: CaptureItem[] = [];

  for (const line of cleaned.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // A line may hold several links; a search phrase is one line, whole.
    const tokens = trimmed.split(/[\s,;]+/).filter(Boolean);
    const urls = tokens.map(asUrl);

    if (urls.some(Boolean)) {
      urls.forEach((url, i) => {
        if (!url) return;
        const item = classifyUrl(url);
        const key = `${item.kind}:${item.value || tokens[i]}`;
        if (seen.has(key)) return;
        seen.add(key);
        items.push(item);
      });
      continue;
    }

    // Not a link: treat it as something to look up on Maps.
    const key = `MAPS_SEARCH:${trimmed.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind: "MAPS_SEARCH", value: trimmed, raw: trimmed });
  }

  return { items, rows: null };
}

/** Groups a plan by what has to run, so one actor run covers many pasted links. */
export function groupForRun(items: CaptureItem[]): Map<Exclude<CaptureKind, "ROWS" | "REJECTED">, string[]> {
  const groups = new Map<Exclude<CaptureKind, "ROWS" | "REJECTED">, string[]>();
  for (const item of items) {
    if (item.kind === "REJECTED" || item.kind === "ROWS") continue;
    const list = groups.get(item.kind) ?? [];
    list.push(item.value);
    groups.set(item.kind, list);
  }
  return groups;
}
