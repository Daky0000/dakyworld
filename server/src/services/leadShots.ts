import { deleteFile, storeFile } from "./fileStore.js";
import type { Screenshot, ShotResult } from "./siteShot.js";

/**
 * Keeping the pictures of a prospect's homepage.
 *
 * Until Sep 2026 a lead's screenshot was an **Apify link** and nothing else:
 * `Screenshot.imageUrl` is a signed key-value-store URL, the run's data is
 * kept for as long as the Apify plan keeps it, and after that the picture on
 * the lead is a broken image. Nothing was lost that could not be re-taken, but
 * "look at what their site looked like when we wrote to them" is a question
 * the record could only answer for a few days — and it is the question the
 * whole scan exists to answer.
 *
 * So the bytes are filed here, as `StoredFile` rows with their own purpose,
 * and served back from this app rather than from Apify.
 *
 * Two rules, both of which are about not filling a database with pictures:
 *
 *  - **Only where a person is going to look.** One lead being prepared files
 *    its pictures; a batch of sixty prepared overnight does not — see
 *    `prepareLeads`, which keeps the links and nothing else. A whole page is
 *    megabytes, and sixty leads is a bill for storage nobody asked for.
 *  - **A re-run replaces rather than adds.** Looking at a business again is
 *    the normal thing to do, and without this the fourth look leaves three
 *    sets of pictures behind with nothing pointing at them.
 */

export type ShotView = "desktop" | "mobile";

/** One view of a homepage, as it is stored on `LeadResearch.shots`. */
export interface StoredShot {
  view: ShotView;
  /** Everything about the picture except the bytes. */
  shot: Screenshot;
  /**
   * The picture the model was shown — the top of the page, 1024 wide.
   * Null when the filing failed, in which case `shot.imageUrl` is all there is.
   */
  fileId: string | null;
  /**
   * The whole page, top to bottom, at the capture width.
   *
   * Null when it was not asked for, when the page was too big to keep, or when
   * nothing was cropped — in that last case the picture above *is* the whole
   * page and a second copy would be storage paid for twice.
   */
  fullFileId: string | null;
  /** True when `fileId` and `fullFileId` would be the same picture. */
  wholePageIsTheCrop: boolean;
}

/** Anything shaped like a stored shot, from a JSON column written by an older build. */
export function storedShotsOf(value: unknown): StoredShot[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is StoredShot =>
      Boolean(entry) && typeof entry === "object" && (entry as StoredShot).view !== undefined && (entry as StoredShot).shot !== undefined,
  );
}

/** The file ids a set of stored shots refers to, for deleting or for a sweep. */
export function shotFileIds(shots: StoredShot[]): string[] {
  const ids: string[] = [];
  for (const entry of shots) {
    if (entry.fileId) ids.push(entry.fileId);
    if (entry.fullFileId && entry.fullFileId !== entry.fileId) ids.push(entry.fullFileId);
  }
  return ids;
}

/** What `storeFile` marks these with, so `orphanedFiles` can tell them from an attachment. */
export const LEAD_SHOT_PURPOSE = "LEAD_SCREENSHOT";

/**
 * Files both views of one lead's homepage and removes whatever the last look
 * left behind.
 *
 * Never throws: a picture that could not be filed is a lead whose screenshot
 * is an Apify link, which is exactly where this feature started, and losing a
 * scan over it would be the wrong way round.
 */
export async function storeLeadShots(args: {
  leadId: string;
  /** Used only for the filename a person downloads. */
  name: string;
  views: { view: ShotView; captured: ShotResult }[];
  /** What the previous look filed, so it can be cleaned up. */
  previous?: StoredShot[];
  notes?: string[];
}): Promise<StoredShot[]> {
  const stored: StoredShot[] = [];

  for (const entry of args.views) {
    const shot = entry.captured.shot;
    if (!shot) continue;

    const slug = args.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "lead";
    const file = async (base64: string, suffix: string): Promise<string | null> => {
      try {
        const saved = await storeFile({
          filename: `${slug}-${entry.view}${suffix}.png`,
          contentType: "image/png",
          dataBase64: base64,
          purpose: LEAD_SHOT_PURPOSE,
        });
        return saved.id;
      } catch (err) {
        args.notes?.push(`The ${entry.view} screenshot could not be kept: ${(err as Error).message}`);
        return null;
      }
    };

    const cropId = entry.captured.base64 ? await file(entry.captured.base64, "") : null;
    // The same bytes twice is not worth a second row. `fullBase64` is set to
    // the crop's own bytes by `siteShot` when nothing was cut, which is how
    // this is known without comparing megabytes.
    const sameBytes = Boolean(entry.captured.fullBase64) && entry.captured.fullBase64 === entry.captured.base64;
    const fullId = entry.captured.fullBase64 && !sameBytes ? await file(entry.captured.fullBase64, "-full") : null;

    stored.push({
      view: entry.view,
      shot,
      fileId: cropId,
      fullFileId: fullId ?? (sameBytes ? cropId : null),
      wholePageIsTheCrop: sameBytes || !shot.cropped,
    });
  }

  // Only once the new ones exist. A lead whose re-run failed part-way should
  // still have last week's pictures rather than none at all.
  if (stored.length && args.previous?.length) {
    for (const id of shotFileIds(args.previous)) await deleteFile(id).catch(() => undefined);
  }

  return stored;
}
