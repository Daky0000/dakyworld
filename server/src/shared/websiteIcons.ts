/**
 * The icons a customer can put on a button without supplying a file.
 *
 * Drawn from Lucide (https://lucide.dev, ISC licence): 24×24, stroked in
 * `currentColor`. That last part is the reason this is a library of markup
 * rather than of image files. An inline icon takes the button's own text
 * colour, so an arrow on a lime button is ink and the same arrow on a dark
 * button is white, with nothing to configure. An `<img>` cannot do that.
 *
 * The server writes these into the page, so a customer's choice is a *name*,
 * never markup. There is no way to send SVG through the editor and have it
 * written into somebody's site; anything else comes in as an image file, which
 * the asset upload has already sanitised.
 */

export type LibraryIcon = { name: string; label: string; body: string };

const I = (name: string, label: string, body: string): LibraryIcon => ({ name, label, body });

export const ICON_LIBRARY: readonly LibraryIcon[] = [
  I("arrow-right", "Arrow right", '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
  I("arrow-left", "Arrow left", '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>'),
  I("arrow-up-right", "Arrow up right", '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>'),
  I("arrow-down", "Arrow down", '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
  I("chevron-right", "Chevron right", '<path d="m9 18 6-6-6-6"/>'),
  I("chevron-down", "Chevron down", '<path d="m6 9 6 6 6-6"/>'),
  I("external-link", "Opens elsewhere", '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  I("download", "Download", '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'),
  I("upload", "Upload", '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>'),
  I("check", "Tick", '<path d="M20 6 9 17l-5-5"/>'),
  I("check-circle", "Tick in a circle", '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
  I("x", "Cross", '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  I("plus", "Plus", '<path d="M5 12h14"/><path d="M12 5v14"/>'),
  I("minus", "Minus", '<path d="M5 12h14"/>'),
  I("phone", "Phone", '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>'),
  I("mail", "Email", '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'),
  I("message-circle", "Chat", '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'),
  I("send", "Send", '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>'),
  I("map-pin", "Location", '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>'),
  I("calendar", "Calendar", '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>'),
  I("clock", "Clock", '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  I("search", "Search", '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  I("menu", "Menu", '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>'),
  I("shopping-cart", "Cart", '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>'),
  I("shopping-bag", "Shopping bag", '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>'),
  I("tag", "Price tag", '<path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/>'),
  I("gift", "Gift", '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>'),
  I("user", "Person", '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  I("users", "People", '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  I("log-in", "Sign in", '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/>'),
  I("heart", "Heart", '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>'),
  I("star", "Star", '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
  I("play", "Play", '<polygon points="6 3 20 12 6 21 6 3"/>'),
  I("zap", "Lightning", '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
  I("info", "Information", '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
  I("alert-triangle", "Warning", '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  I("home", "Home", '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
  I("globe", "Globe", '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>'),
  I("lock", "Padlock", '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  I("file-text", "Document", '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
];

const BY_NAME = new Map(ICON_LIBRARY.map((icon) => [icon.name, icon]));

export function libraryIcon(name: string): LibraryIcon | undefined {
  return BY_NAME.get(name);
}

/** What the replaced icon was wearing, carried onto its replacement. */
export type IconFrame = { className?: string; width?: string; height?: string };

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The icon's size when the page gave none: the height of a capital letter in
 * whatever the button's text is set in, so it sits in the line rather than on it.
 */
const INLINE = "width:1em;height:1em;vertical-align:-0.125em;flex-shrink:0";

function frameAttrs(frame: IconFrame): { size: string; cls: string } {
  const sized = Boolean(frame.width || frame.height);
  return {
    size: sized
      ? `${frame.width ? ` width="${attr(frame.width)}"` : ""}${frame.height ? ` height="${attr(frame.height)}"` : ""}`
      : ` width="1em" height="1em" style="${INLINE}"`,
    cls: frame.className ? ` class="${attr(frame.className)}"` : "",
  };
}

/** A library icon, as the markup written into the page. */
export function libraryIconMarkup(icon: LibraryIcon, frame: IconFrame = {}): string {
  const { size, cls } = frameAttrs(frame);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"${size}${cls} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" data-dw-icon="${attr(icon.name)}">${icon.body}</svg>`;
}

/** An image file used as an icon. Decorative: the button's words say what it does. */
export function imageIconMarkup(src: string, frame: IconFrame = {}): string {
  const { size, cls } = frameAttrs(frame);
  return `<img src="${attr(src)}" alt="" aria-hidden="true"${size.replace(INLINE, `${INLINE};object-fit:contain`)}${cls}>`;
}

/**
 * Where an icon image may come from: this site, or an https address.
 *
 * Nothing with a scheme other than http(s), no quotes or angle brackets, no
 * whitespace. The value lands in an attribute of somebody's published page.
 */
export function safeIconSrc(raw: string): string | null {
  const src = raw.trim();
  if (!src || src.length > 2_000 || /[\s"'<>`\\]/.test(src)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(src)?.[1]?.toLowerCase();
  if (scheme && scheme !== "https" && scheme !== "http") return null;
  if (src.startsWith("//")) return null;
  return src;
}

/** What somebody chose for an icon: a library icon by name, or an image file. */
export type IconChoice = { library: string } | { src: string };

/**
 * The markup a choice becomes, or null when the choice is not one this editor
 * accepts. The server writes this into the page and the editor draws the same
 * string in its preview, so the two cannot disagree about what was picked.
 */
export function iconChoiceMarkup(choice: IconChoice, frame: IconFrame = {}): string | null {
  if ("library" in choice) {
    const icon = libraryIcon(choice.library);
    return icon ? libraryIconMarkup(icon, frame) : null;
  }
  const src = safeIconSrc(choice.src);
  return src ? imageIconMarkup(src, frame) : null;
}
