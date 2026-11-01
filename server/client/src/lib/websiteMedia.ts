export type WebsiteMediaAsset = { url: string; preview: string };

export type WebsiteMediaContext = {
  pageUrl: string;
  editorUrl: string;
  assets: readonly WebsiteMediaAsset[];
};

function absoluteUrl(value: string, base: string): string {
  try { return new URL(value, base).href; } catch { return value; }
}

/** Keep publish paths in drafts, but load unpublished uploads from the editor. */
export function websiteMediaPreviewUrl(value: string, context: WebsiteMediaContext): string {
  const raw = value.trim();
  if (!raw) return "";
  const source = absoluteUrl(raw, context.pageUrl);
  const asset = context.assets.find(candidate => candidate.url === raw || absoluteUrl(candidate.url, context.pageUrl) === source);
  if (asset) return absoluteUrl(asset.preview, context.editorUrl);
  // The preview document has the published site's <base>, so API paths and local demo/dw assets must
  // explicitly retain the editor origin even when written into that document.
  const preferEditor = /^\/(?:api|demos|assets)\//i.test(raw);
  return absoluteUrl(raw, preferEditor ? context.editorUrl : context.pageUrl);
}

/** Recover the publish path from a captured preview or absolute site URL. */
export function websiteMediaSourceUrl(value: string, context: WebsiteMediaContext): string {
  const source = absoluteUrl(value, /^\/api\//i.test(value) ? context.editorUrl : context.pageUrl);
  return context.assets.find(asset => absoluteUrl(asset.preview, context.editorUrl) === source || absoluteUrl(asset.url, context.pageUrl) === source)?.url ?? value;
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

/**
 * Check whether a candidate media URL (from an img src, srcset, CSS background-image, or computed style)
 * refers to the same target media asset. Handles:
 * - Direct equality
 * - Quotes and spaces
 * - Root-relative vs relative paths (e.g. "/images/hero.jpg" vs "images/hero.jpg")
 * - Framework container prefixes ("public/images/hero.jpg" vs "images/hero.jpg" or "/images/hero.jpg")
 * - Editor preview API paths (/api/website/sites/.../assets/.../content)
 */
export function matchesWebsiteMediaUrl(candidate: string, target: string, previewUrl?: string): boolean {
  if (!candidate || !target) return false;
  const clean = (u: string) => u.trim().replace(/^['"]|['"]$/g, "");
  const c = clean(candidate);
  const t = clean(target);
  if (c === t) return true;
  if (previewUrl) {
    const p = clean(previewUrl);
    if (c === p || c.includes(p) || p.includes(c)) return true;
  }

  const getPath = (u: string) => {
    try {
      if (/^[a-z]+:\/\//i.test(u)) return new URL(u).pathname;
    } catch {}
    return u.split("?")[0].split("#")[0];
  };

  const cPath = getPath(c).replace(/^\/+/, "");
  const tPath = getPath(t).replace(/^\/+/, "");
  if (cPath && tPath && cPath === tPath) return true;

  const stripContainer = (p: string) => p.replace(/^(?:public|static|assets)\//, "");
  if (cPath && tPath && stripContainer(cPath) === stripContainer(tPath)) return true;

  const cFile = cPath.split("/").pop();
  const tFile = tPath.split("/").pop();
  if (cFile && tFile && cFile === tFile) {
    if (cPath.endsWith(tPath) || tPath.endsWith(cPath)) return true;
    if (stripContainer(cPath).endsWith(stripContainer(tPath)) || stripContainer(tPath).endsWith(stripContainer(cPath))) return true;
  }

  return false;
}

