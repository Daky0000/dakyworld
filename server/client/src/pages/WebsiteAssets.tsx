import { PlannedScreen } from "../components/PlannedScreen";

/**
 * Pictures — plan §4 stage 2.
 *
 * The most-asked-for missing thing for a client: today they can change the words
 * on a page and the address of an image, and they cannot put a new photograph on
 * their own website without a developer.
 */
export function WebsiteAssets() {
  return (
    <PlannedScreen
      title="Assets"
      summary="Every picture on the site: what it is, where it is used, and how to replace it."
      willHold={[
        "Upload → judge the bytes → strip metadata → resize and compress → commit to the repository → update the field's src and alt.",
        "The library: every uploaded image with its alt text, its real dimensions, and which page and field uses it.",
        "Crop, focal point, and a decorative flag for pictures that carry no meaning.",
        "A warning on anything committed that no page references — an asset nothing uses is weight on every visitor's download.",
      ]}
      decided={[
        "No native image dependency. Cloudinary is already a dependency and already configured from encrypted settings, so it is the resize and strip pipeline.",
        "With no Cloudinary key — today's state — it degrades rather than fails: PNG through the decoder already in services/png.ts, JPEG and WebP accepted under a size cap with a note saying they were not recompressed.",
        "The bytes are committed to the repository, not linked from a CDN. The published site must not depend on anything external, and the repository stays the source of truth for pictures as it is for words.",
        "Uploads are judged on their bytes with assertImageBytes, never on the filename or the data: prefix — both of which the caller writes.",
      ]}
      waitingOn={["A SiteAsset model", "The upload path added to UPLOAD_PATHS in index.ts and its own body parser inside the router — both, or it fails at 100 kB"]}
    />
  );
}
