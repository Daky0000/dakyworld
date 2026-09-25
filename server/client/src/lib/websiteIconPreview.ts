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

  // 1. Direct or embedded SVG
  const svgMatch = /<svg\b[\s\S]*?<\/svg>/i.exec(markup);
  if (svgMatch) return svgPreviewSrc(svgMatch[0]);

  // 2. Direct or embedded <img>
  const imgMatch = /<img\b[^>]*>/i.exec(markup);
  if (imgMatch) return imgPreviewSrc(imgMatch[0], publicUrl);

  // 3. Background image URL in style or markup
  const bgMatch = /background(?:-image)?\s*:\s*[^;}]*?url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(markup);
  if (bgMatch && bgMatch[1]) {
    const raw = bgMatch[1].replace(/&amp;/g, "&").trim();
    if (raw) {
      try {
        return new URL(raw, `${publicUrl.replace(/\/+$/, "")}/`).href;
      } catch {
        return raw;
      }
    }
  }

  // 4. Custom hand-drawn brand-face logo glyph
  if (/\bbrand-face\b/i.test(markup)) {
    return svgPreviewSrc(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 36" fill="none" stroke="currentColor" stroke-width="2">' +
      '<path d="M2 3h44v14c0 9-7 16-16 16H18C9 33 2 26 2 17V3z" stroke="currentColor" stroke-width="2.5"/>' +
      '<circle cx="15" cy="12" r="2" fill="currentColor"/>' +
      '<circle cx="33" cy="12" r="2" fill="currentColor"/>' +
      '<path d="M17 21 Q24 27 31 21" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>' +
      '</svg>'
    );
  }

  // 5. Bare image path or URL
  const trimmed = markup.trim();
  if (/^(?:https?:|\/|data:image\/)/i.test(trimmed) || /\.(?:png|jpe?g|svg|webp|gif|avif)(?:\?|$)/i.test(trimmed)) {
    try {
      return new URL(trimmed, `${publicUrl.replace(/\/+$/, "")}/`).href;
    } catch {
      return trimmed;
    }
  }

  const inner = /^\s*<(?:i|span|div)\b[^>]*>\s*(<(?:svg|img)[\s\S]*)<\/(?:i|span|div)>\s*$/i.exec(markup)?.[1];
  const candidate = inner ?? markup;
  return svgPreviewSrc(candidate) ?? imgPreviewSrc(candidate, publicUrl);
}

/** A short name for what a font icon's classes say it is: "fa-phone" reads as "phone". */
export function fontIconName(markup: string | undefined): string {
  const cls = markup ? /\sclass\s*=\s*"([^"]*)"/i.exec(markup)?.[1] ?? "" : "";
  const token = cls.split(/\s+/).reverse().find((word) => /^(?:fa|bi|icon|ti|ri|mdi|las|lab|glyphicon)-/i.test(word));
  return token ? token.replace(/^(?:fa|bi|icon|ti|ri|mdi|las|lab|glyphicon)-/i, "").replace(/-/g, " ") : "icon font";
}
