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
  // The preview document has the published site's <base>, so API paths must
  // explicitly retain the editor origin even when written into that document.
  return absoluteUrl(raw, /^\/api\//i.test(raw) ? context.editorUrl : context.pageUrl);
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
