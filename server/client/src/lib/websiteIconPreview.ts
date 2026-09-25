/**
 * How the editor shows an icon it did not draw.
 *
 * An icon read off somebody's page is their markup, and nothing of theirs is
 * ever put into the editor's own document. It is shown as the source of an
 * `<img>`, where an SVG is a picture and cannot run anything, whatever it holds.
 */

/** An inline SVG as an image address, or null when there is no SVG to show. */
export function svgPreviewSrc(markup: string | undefined): string | null {
  if (!markup || !/^\s*<svg[\s>]/i.test(markup)) return null;
  const withNamespace = /\sxmlns\s*=/.test(markup.slice(0, markup.indexOf(">") + 1))
    ? markup
    : markup.replace(/^\s*<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withNamespace)}`;
}

/** The file an `<img>` icon points at, resolved against the site. */
export function imgPreviewSrc(markup: string | undefined, publicUrl: string): string | null {
  const src = markup && /^\s*<img\b/i.test(markup) ? /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(markup) : null;
  const raw = src ? (src[1] ?? src[2] ?? "") : "";
  if (!raw) return null;
  try {
    return new URL(raw.replace(/&amp;/g, "&"), `${publicUrl.replace(/\/+$/, "")}/`).href;
  } catch {
    return null;
  }
}

/** Whatever can be shown of an icon: an SVG, an image, or nothing (an icon font). */
export function iconPreviewSrc(markup: string | undefined, publicUrl: string): string | null {
  if (!markup) return null;
  const inner = /^\s*<(?:i|span)\b[^>]*>\s*(<(?:svg|img)[\s\S]*)<\/(?:i|span)>\s*$/i.exec(markup)?.[1];
  const candidate = inner ?? markup;
  return svgPreviewSrc(candidate) ?? imgPreviewSrc(candidate, publicUrl);
}

/** A short name for what a font icon's classes say it is: "fa-phone" reads as "phone". */
export function fontIconName(markup: string | undefined): string {
  const cls = markup ? /\sclass\s*=\s*"([^"]*)"/i.exec(markup)?.[1] ?? "" : "";
  const token = cls.split(/\s+/).reverse().find((word) => /^(?:fa|bi|icon|ti|ri|mdi|las|lab|glyphicon)-/i.test(word));
  return token ? token.replace(/^(?:fa|bi|icon|ti|ri|mdi|las|lab|glyphicon)-/i, "").replace(/-/g, " ") : "icon font";
}
