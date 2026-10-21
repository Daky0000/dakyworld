/**
 * What an embedded frame on a page may show: a video, a map, a music or podcast
 * player, a calendar — from a short list of services, and nothing else.
 *
 * A frame was a preserved element: it could be moved, styled and deleted, and
 * the one thing anybody actually wants to do to one — show a different video,
 * move the map to the new shop — meant editing the HTML. This is the typed
 * control for that, shared by the panel (which turns a pasted link into the
 * address the service embeds from, and says why when it cannot) and by the
 * server (which holds every address to the same list again before writing it,
 * through `attributeProblem` in `websiteElementSettings.ts`).
 *
 * **The list is the security boundary, and it is a list on purpose.** A link
 * can already go anywhere, but a frame draws another site *inside* this one,
 * at the size and place the designer gave it. An invited editor pointing a
 * frame at a page of their own is a sign-in form wearing the customer's
 * header. So an address must be https, carry no credentials or port, sit on
 * one of these hosts, and on that host be the path the service embeds from.
 * `srcdoc` is never reachable at all (`ADDRESS_ATTRIBUTES`). A frame already
 * pointing somewhere off the list keeps working and can be moved, styled and
 * deleted; it can only be pointed at something on the list.
 *
 * Nothing here fetches anything, so an address is never "checked" by loading
 * it: a service changing its paths shows up as a refusal with a sentence, not
 * as a request this server made on somebody's behalf.
 */

export type EmbedService = {
  id: string;
  /** For a person: "YouTube", in "This frame shows a YouTube video". */
  label: string;
  /** What it shows, for the same sentence. */
  noun: string;
  hosts: readonly string[];
  /** The embeddable paths on those hosts. */
  path: RegExp;
  /** Further rule on the query, where the path alone is not the embed. */
  query?: (params: URLSearchParams) => boolean;
};

export const EMBED_SERVICES: readonly EmbedService[] = [
  { id: "youtube", label: "YouTube", noun: "video", hosts: ["www.youtube.com", "youtube.com", "www.youtube-nocookie.com", "youtube-nocookie.com"], path: /^\/embed\/(?:[A-Za-z0-9_-]{6,20}|videoseries)$/ },
  { id: "vimeo", label: "Vimeo", noun: "video", hosts: ["player.vimeo.com"], path: /^\/video\/\d{3,12}$/ },
  { id: "loom", label: "Loom", noun: "video", hosts: ["www.loom.com", "loom.com"], path: /^\/embed\/[0-9a-f]{16,40}$/ },
  { id: "wistia", label: "Wistia", noun: "video", hosts: ["fast.wistia.net", "fast.wistia.com"], path: /^\/embed\/iframe\/[A-Za-z0-9]{4,20}$/ },
  {
    id: "google-maps", label: "Google Maps", noun: "map", hosts: ["www.google.com", "google.com", "maps.google.com"],
    // Share → Embed a map gives `/maps/embed?pb=…`; the keyless form is
    // `/maps?q=…&output=embed`, which is what a typed place becomes.
    path: /^\/maps(?:\/embed)?$/,
    query: (params) => params.has("pb") || params.get("output") === "embed",
  },
  { id: "openstreetmap", label: "OpenStreetMap", noun: "map", hosts: ["www.openstreetmap.org"], path: /^\/export\/embed\.html$/ },
  { id: "spotify", label: "Spotify", noun: "player", hosts: ["open.spotify.com"], path: /^\/embed\/(?:track|album|playlist|episode|show|artist)\/[A-Za-z0-9]{10,40}$/ },
  { id: "soundcloud", label: "SoundCloud", noun: "player", hosts: ["w.soundcloud.com"], path: /^\/player\/?$/ },
  { id: "apple", label: "Apple Music or Podcasts", noun: "player", hosts: ["embed.music.apple.com", "embed.podcasts.apple.com"], path: /^\/[a-z]{2}\/[^/]+(?:\/[^/]+){1,3}$/ },
  { id: "google-calendar", label: "Google Calendar", noun: "calendar", hosts: ["calendar.google.com"], path: /^\/calendar\/(?:u\/\d\/)?embed$/ },
  { id: "calendly", label: "Calendly", noun: "booking calendar", hosts: ["calendly.com"], path: /^\/[A-Za-z0-9_-]{2,60}(?:\/[A-Za-z0-9_-]{1,60})?$/ },
];

/** Long enough for a Google Maps `pb=` address, which is the longest of them. */
export const MAX_EMBED_ADDRESS = 2048;

const FORBIDDEN = /[\s"'<>`\\\u0000-\u001f\u007f]/;

/** The service an https address embeds from, or null when it is not on the list. */
export function embedService(address: string): EmbedService | null {
  if (!address || address.length > MAX_EMBED_ADDRESS || FORBIDDEN.test(address)) return null;
  let parsed: URL;
  try { parsed = new URL(address); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
  const host = parsed.hostname.toLowerCase();
  return EMBED_SERVICES.find((service) => service.hosts.includes(host) && service.path.test(parsed.pathname) && (!service.query || service.query(parsed.searchParams))) ?? null;
}

/** Why a frame may not be pointed at this address, or null when it may. The server's rule. */
export function embedProblem(address: string): string | null {
  if (address.length > MAX_EMBED_ADDRESS) return "That address is too long to be an embed.";
  if (embedService(address)) return null;
  return `A frame can show ${EMBED_SERVICES.map((service) => service.label).slice(0, -1).join(", ")} or ${EMBED_SERVICES.at(-1)!.label}. Paste the link or the embed code that service gives you.`;
}

/** Seconds from YouTube's `t=` — `90`, `90s` or `1m30s`. */
function seconds(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+s?$/.test(value)) return Number.parseInt(value, 10);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!match || !match[0]) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

/**
 * Whatever somebody pasted — a share link, a watch page, the service's whole
 * `<iframe>` embed code — as the address a frame embeds from, or the sentence
 * saying why it cannot be one. The result always passes `embedProblem`.
 */
export function embedAddress(input: string): { address: string } | { problem: string } {
  let text = input.trim();
  if (!text) return { problem: "Paste a link to a video, a map or a player." };
  // The embed code a service hands out: take its address and nothing else.
  const code = /<iframe\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(text);
  if (code) text = (code[1] ?? code[2] ?? code[3] ?? "").replace(/&amp;/g, "&").trim();
  else if (/<|>/.test(text)) return { problem: "That looks like code, but not an embed code. Paste the link to the video or map instead." };
  if (/^\/\//.test(text)) text = `https:${text}`;
  else if (!/^[a-z]+:/i.test(text)) text = `https://${text}`;
  let url: URL;
  try { url = new URL(text); } catch { return { problem: "That is not a link. Paste the address from the browser's address bar, or the service's embed code." }; }
  if (url.protocol === "http:") url.protocol = "https:";
  const host = url.hostname.toLowerCase().replace(/^m\./, "www.");

  // YouTube: a watch page, a short, a live stream, a youtu.be link or a playlist.
  if (host === "youtu.be" || host === "www.youtube.com" || host === "youtube.com" || host === "music.youtube.com") {
    const list = url.searchParams.get("list");
    const id = host === "youtu.be"
      ? url.pathname.slice(1).split("/")[0]
      : url.pathname === "/watch" ? url.searchParams.get("v") : /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,20})/.exec(url.pathname)?.[1];
    const start = seconds(url.searchParams.get("t") ?? url.searchParams.get("start"));
    if (id && /^[A-Za-z0-9_-]{6,20}$/.test(id)) {
      const params = new URLSearchParams();
      if (start) params.set("start", String(start));
      if (list && /^[A-Za-z0-9_-]+$/.test(list)) params.set("list", list);
      const query = params.toString();
      return checked(`https://www.youtube.com/embed/${id}${query ? `?${query}` : ""}`);
    }
    if (list && /^[A-Za-z0-9_-]+$/.test(list)) return checked(`https://www.youtube.com/embed/videoseries?list=${list}`);
  }
  // Vimeo: `vimeo.com/123456`, and an unlisted video's `vimeo.com/123456/abcdef` hash.
  if (host === "vimeo.com" || host === "www.vimeo.com") {
    const match = /^\/(?:video\/)?(\d{3,12})(?:\/([0-9a-f]{6,20}))?\/?$/.exec(url.pathname);
    if (match) return checked(`https://player.vimeo.com/video/${match[1]}${match[2] ? `?h=${match[2]}` : ""}`);
  }
  // Spotify: `open.spotify.com/(intl-xx/)track/…` and the rest.
  if (host === "open.spotify.com") {
    const match = /^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(?:embed\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{10,40})/.exec(url.pathname);
    if (match) return checked(`https://open.spotify.com/embed/${match[1]}/${match[2]}`);
  }
  // Loom: a share link becomes its embed.
  if (host === "www.loom.com" || host === "loom.com") {
    const match = /^\/(?:share|embed)\/([0-9a-f]{16,40})/.exec(url.pathname);
    if (match) return checked(`https://www.loom.com/embed/${match[1]}`);
  }
  // Apple Music and Podcasts embed from a sibling host with the same path.
  if (host === "music.apple.com" || host === "podcasts.apple.com") return checked(`https://embed.${host}${url.pathname}${url.search}`);
  // A Google Maps page or share link has no embed form that can be worked out
  // from it; the place name can, and so can the map's own embed code.
  if ((host === "www.google.com" || host === "google.com" || host === "maps.google.com") && /^\/maps/.test(url.pathname) && !embedService(url.href)) {
    const place = /^\/maps\/place\/([^/@]+)/.exec(url.pathname)?.[1];
    if (place) return checked(mapAddress(decodeURIComponent(place.replace(/\+/g, " "))));
    return { problem: "That Google Maps link can't be shown in a frame. Type the place's name or address under Place instead, or use Share → Embed a map and paste its code here." };
  }
  if (host === "maps.app.goo.gl" || host === "goo.gl") {
    return { problem: "A short Maps link can't be shown in a frame. Type the place's name or address under Place, or use Share → Embed a map and paste its code here." };
  }
  return checked(url.href);
}

function checked(address: string): { address: string } | { problem: string } {
  const problem = embedProblem(address);
  return problem ? { problem } : { address };
}

/**
 * A Google Maps frame showing a place, from its name or address — the form that
 * needs no API key. `zoom` is Google's: 15 is a few streets around it.
 */
export function mapAddress(place: string, zoom = 15): string {
  const params = new URLSearchParams({ q: place.trim().replace(/\s+/g, " ").slice(0, 300), z: String(Math.min(21, Math.max(1, Math.round(zoom)))), output: "embed" });
  return `https://maps.google.com/maps?${params}`;
}

/** The place a keyless Google Maps frame shows, or null for any other frame. */
export function mapPlace(address: string): string | null {
  try {
    const url = new URL(address);
    if (url.hostname !== "maps.google.com" || url.pathname !== "/maps" || url.searchParams.get("output") !== "embed") return null;
    return url.searchParams.get("q");
  } catch { return null; }
}
