export type WebsiteMediaAsset = { url: string; preview: string };

export type WebsiteMediaContext = {
  pageUrl: string;
  editorUrl: string;
  siteUrl?: string;
  assets: readonly WebsiteMediaAsset[];
};

/**
 * A data: or blob: address is its own picture: it has no publish path to recover
 * and no file name to match. Parsing one as a URL is not free either — a page
 * with its pictures inlined hands these helpers megabytes of base64, and the
 * media list runs them on every edit, so each opacity drag step paid for it.
 */
const INLINE_MEDIA = /^\s*['"]?(?:data|blob):/i;

function absoluteUrl(value: string, base: string): string {
  try { return new URL(value, base).href; } catch { return value; }
}

function extractComparableSegments(value: string): string[] {
  if (!value) return [];
  let p = value.trim().replace(/^['"]|['"]$/g, "");
  try {
    if (/^[a-z]+:\/\//i.test(p)) {
      p = new URL(p).pathname;
    }
  } catch {}
  p = p.split("?")[0].split("#")[0];
  try { p = decodeURIComponent(p); } catch {}
  const segments = p.split("/").filter(Boolean);
  // Filter out build/package container folders and relative dot segments wherever they occur
  return segments.filter((s) => !/^(?:public|static|dist|out|\.|\.\.)$/i.test(s));
}

/** Keep publish paths in drafts, but load unpublished uploads from the editor. */
export function websiteMediaPreviewUrl(value: string, context: WebsiteMediaContext): string {
  const raw = value.trim();
  if (!raw) return "";
  if (INLINE_MEDIA.test(raw)) return raw;
  const source = absoluteUrl(raw, context.pageUrl);

  const getHost = (u: string) => {
    try { if (/^[a-z]+:\/\//i.test(u)) return new URL(u).host; } catch {}
    return null;
  };
  const rawHost = getHost(raw);
  const pageHost = getHost(context.pageUrl);
  const editorHost = getHost(context.editorUrl);
  const siteHost = context.siteUrl ? getHost(context.siteUrl) : null;
  const isForeignHost = rawHost && rawHost !== pageHost && rawHost !== editorHost && rawHost !== siteHost;

  if (!isForeignHost) {
    const asset = context.assets.find(
      candidate =>
        candidate.url === raw ||
        absoluteUrl(candidate.url, context.pageUrl) === source ||
        matchesWebsiteMediaUrl(candidate.url, raw) ||
        (candidate.preview && matchesWebsiteMediaUrl(candidate.preview, raw))
    );
    if (asset) return absoluteUrl(asset.preview, context.editorUrl);
  }
  // The preview document has the published site's <base>, so API paths and local demo/dw assets must
  // explicitly retain the editor origin even when written into that document.
  const preferEditor = /^\/(?:api|demos|assets)\//i.test(raw);
  return absoluteUrl(raw, preferEditor ? context.editorUrl : context.pageUrl);
}

/** Recover the publish path from a captured preview or absolute site URL. */
export function websiteMediaSourceUrl(value: string, context: WebsiteMediaContext): string {
  if (INLINE_MEDIA.test(value)) return value;
  const getHost = (u: string) => {
    try { if (/^[a-z]+:\/\//i.test(u)) return new URL(u).host; } catch {}
    return null;
  };
  const valHost = getHost(value);
  const pageHost = getHost(context.pageUrl);
  const editorHost = getHost(context.editorUrl);
  const siteHost = context.siteUrl ? getHost(context.siteUrl) : null;
  const isForeignHost = valHost && valHost !== pageHost && valHost !== editorHost && valHost !== siteHost;

  if (isForeignHost) return value;

  const source = absoluteUrl(value, /^\/api\//i.test(value) ? context.editorUrl : context.pageUrl);
  return (
    context.assets.find(
      asset =>
        absoluteUrl(asset.preview, context.editorUrl) === source ||
        absoluteUrl(asset.url, context.pageUrl) === source ||
        matchesWebsiteMediaUrl(asset.url, value) ||
        (asset.preview && matchesWebsiteMediaUrl(asset.preview, value))
    )?.url ?? value
  );
}

/** Rewrite only URL tokens; saved CSS and all other declarations stay intact. */
export function rewriteWebsiteMediaStyle(style: string, resolveUrl: (value: string) => string): string {
  return style.replace(/url\(\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^'"()\s][^()]*?))\s*\)/gi, (token, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined) => {
    const raw = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
    // Leave escaped CSS and local fragment references to the browser.
    if (!raw || raw.includes("\\") || raw.startsWith("#")) return token;
    const resolved = resolveUrl(raw.trim());
    return resolved === raw ? token : `url("${resolved.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\f]/g, "")}")`;
  });
}

function matchesSingleMediaUrl(candidate: string, target: string): boolean {
  if (!candidate || !target) return false;
  const clean = (u: string) => u.trim().replace(/^['"]|['"]$/g, "");
  const c = clean(candidate);
  const t = clean(target);
  if (c === t) return true;
  if (INLINE_MEDIA.test(c) || INLINE_MEDIA.test(t)) return false;

  const cSegs = extractComparableSegments(c);
  const tSegs = extractComparableSegments(t);
  if (!cSegs.length || !tSegs.length) return false;

  const cFile = cSegs[cSegs.length - 1]!.toLowerCase();
  const tFile = tSegs[tSegs.length - 1]!.toLowerCase();
  if (cFile !== tFile) return false;

  // Single segment matches (e.g. filename only like "photo.jpg")
  if (cSegs.length === 1 || tSegs.length === 1) return true;

  const cStr = cSegs.map((s) => s.toLowerCase()).join("/");
  const tStr = tSegs.map((s) => s.toLowerCase()).join("/");
  if (cStr === tStr) return true;
  if (cStr.endsWith(`/${tStr}`) || tStr.endsWith(`/${cStr}`)) return true;

  // Also match if both end with the same directory + filename (e.g. hero/photo.jpg)
  if (cSegs.length >= 2 && tSegs.length >= 2) {
    const cTail = `${cSegs[cSegs.length - 2]!.toLowerCase()}/${cFile}`;
    const tTail = `${tSegs[tSegs.length - 2]!.toLowerCase()}/${tFile}`;
    if (cTail === tTail) return true;
  }

  return false;
}

/**
 * Check whether a candidate media URL (from an img src, srcset, CSS background-image, or computed style)
 * refers to the same target media asset. Handles:
 * - Direct equality
 * - Quotes and spaces
 * - Root-relative vs relative paths (e.g. "/images/hero.jpg" vs "images/hero.jpg" or "./images/hero.jpg")
 * - Framework container prefixes ("public/images/hero.jpg" vs "images/hero.jpg" or "/images/hero.jpg")
 * - Subpath deployment prefixes ("/africon-app/public/images/hero.jpg" vs "images/hero.jpg")
 * - Editor preview API paths (/api/website/sites/.../assets/.../content)
 *
 * Distinct files with different filenames (such as hero-1.jpg vs hero-3.jpg) are strictly never matched,
 * even when sharing an origin, folder, or subpath.
 */
export function matchesWebsiteMediaUrl(candidate: string, target: string, previewUrl?: string): boolean {
  if (!candidate || !target) return false;
  if (matchesSingleMediaUrl(candidate, target)) return true;
  if (previewUrl && previewUrl !== target) {
    const clean = (u: string) => u.trim().replace(/^['"]|['"]$/g, "");
    const c = clean(candidate);
    const p = clean(previewUrl);
    if (c === p) return true;
    if (matchesSingleMediaUrl(candidate, previewUrl)) return true;
  }
  return false;
}

