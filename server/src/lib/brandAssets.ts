import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
 * **Small on purpose.** These are palette-reduced cuts of the real lock-ups,
 * about 5 KB each rather than the 100 KB masters, because they ride along on
 * every single message. Regenerate them from `assets/brand/` if the identity
 * changes — the recipe is in server/assets/README.md.
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

// Read once per process: the files cannot change while it runs, and re-reading
// them for every email in a sequence would be pointless disk work.
const loaded = new Map<string, Buffer | null>();

function read(cid: string): Buffer | null {
  const cached = loaded.get(cid);
  if (cached !== undefined) return cached;

  const file = candidates(FILES[cid] ?? "").find((candidate) => fs.existsSync(candidate));
  const buffer = file ? fs.readFileSync(file) : null;
  loaded.set(cid, buffer);
  return buffer;
}

/** True when the artwork is actually on disk, so the shell can fall back to type. */
export function hasBrandImage(cid: string): boolean {
  return read(cid) !== null;
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
export function inlineBrandImages(html: string): InlineImage[] {
  const images: InlineImage[] = [];
  for (const cid of Object.keys(FILES)) {
    if (!html.includes(`cid:${cid}`)) continue;
    const content = read(cid);
    if (!content) continue;
    images.push({ filename: FILES[cid], content, contentType: "image/png", cid });
  }
  return images;
}
