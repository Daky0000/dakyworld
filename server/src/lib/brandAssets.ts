import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brandImage, decodeDataUrl, type BrandSlot } from "../services/systemProfile.js";

/**
 * The logo files an email carries with it.
 *
 * **Embedded, not linked.** A hosted `<img src="https://…">` is the usual way,
 * and it is the reason so much business email arrives as a broken grey box:
 * Outlook blocks remote images by default, and the apex domain has been
 * unreliable enough (see DOMAINS.md) that the logo would have gone missing for
 * real. Attaching the artwork as an inline part and pointing at it with
 * `cid:` needs nothing outside the message, so it renders on the plane, in
 * Outlook, and on a domain that is mid-migration. Both transports support it —
 * nodemailer natively, and Hostinger's send API takes a `cid` per attachment.
 *
 * **Two sources, in order.** Artwork uploaded on the System settings screen
 * wins; the files shipped in `server/assets/` are the fallback. That order is
 * what makes changing the logo a thing the Owner does rather than a deploy —
 * and the fallback is what keeps every email rendering before anything has
 * been uploaded.
 *
 * **Small on purpose.** The shipped files are palette-reduced cuts of the real
 * lock-ups, about 5 KB each rather than the 100 KB masters, because they ride
 * along on every single message. Regenerate them from `assets/brand/` if the
 * identity changes — the recipe is in server/assets/README.md. An upload is
 * held to the same standard by the size limit on the route.
 */

/** Referenced from the HTML as `<img src="cid:dakyworld-logo">`. */
export const LOGO_CID = "dakyworld-logo";
/** The on-dark cut, for the footer band. */
export const LOGO_DARK_CID = "dakyworld-logo-dark";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Both the compiled layout (dist/lib) and the source one (src/lib) find these. */
function candidates(name: string): string[] {
  return [path.resolve(here, "../../assets", name), path.resolve(here, "../../../assets", name)];
}

const FILES: Record<string, string> = {
  [LOGO_CID]: "logo-email.png",
  [LOGO_DARK_CID]: "logo-email-dark.png",
};

/** Which uploaded slot stands in for each cid. */
const SLOTS: Record<string, BrandSlot> = {
  [LOGO_CID]: "logoLight",
  [LOGO_DARK_CID]: "logoDark",
};

// The shipped files are read once per process: they cannot change while it
// runs, and re-reading them for every email in a sequence would be pointless
// disk work. The uploaded ones are cached by systemProfile instead, so that
// clearing that cache is all a save has to do.
const loaded = new Map<string, Buffer | null>();

function readShipped(cid: string): Buffer | null {
  const cached = loaded.get(cid);
  if (cached !== undefined) return cached;

  const file = candidates(FILES[cid] ?? "").find((candidate) => fs.existsSync(candidate));
  const buffer = file ? fs.readFileSync(file) : null;
  loaded.set(cid, buffer);
  return buffer;
}

export interface BrandArtwork {
  content: Buffer;
  contentType: string;
  filename: string;
}

/** The artwork for one cid: uploaded first, shipped second, null when neither exists. */
export async function brandArtwork(cid: string): Promise<BrandArtwork | null> {
  const slot = SLOTS[cid];
  if (slot) {
    const stored = await brandImage(slot);
    const decoded = stored ? decodeDataUrl(stored) : null;
    if (decoded) {
      const extension = decoded.contentType.split("/")[1]?.replace("+xml", "") ?? "png";
      return { content: decoded.buffer, contentType: decoded.contentType, filename: `${cid}.${extension}` };
    }
  }

  const shipped = readShipped(cid);
  return shipped ? { content: shipped, contentType: "image/png", filename: FILES[cid] } : null;
}

/** True when there is artwork to point a `cid:` at, so the shell can fall back to type. */
export async function hasBrandImage(cid: string): Promise<boolean> {
  return (await brandArtwork(cid)) !== null;
}

/**
 * The same artwork as a data URL, for the places that cannot resolve a `cid:`
 * — the preview iframe in the composer, and anything rendered to a page rather
 * than to a message.
 */
export async function brandDataUrl(cid: string): Promise<string | null> {
  const artwork = await brandArtwork(cid);
  return artwork ? `data:${artwork.contentType};base64,${artwork.content.toString("base64")}` : null;
}

export interface InlineImage {
  filename: string;
  content: Buffer;
  contentType: string;
  cid: string;
}

/**
 * The inline parts a given piece of HTML actually refers to. Driven by the
 * HTML rather than attached unconditionally, so a plain message — or one built
 * before this existed — carries no attachment at all.
 */
export async function inlineBrandImages(html: string): Promise<InlineImage[]> {
  const images: InlineImage[] = [];
  for (const cid of Object.keys(FILES)) {
    if (!html.includes(`cid:${cid}`)) continue;
    const artwork = await brandArtwork(cid);
    if (!artwork) continue;
    images.push({ filename: artwork.filename, content: artwork.content, contentType: artwork.contentType, cid });
  }
  return images;
}
