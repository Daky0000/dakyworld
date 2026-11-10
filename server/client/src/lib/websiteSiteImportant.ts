import { parseStyle, writeStyle } from "../components/InspectorControls";

const IMPORTANT = /\s*!\s*important\s*$/i;

/**
 * A Style-tab change that the site's own `!important` would throw away, made
 * to win.
 *
 * The editor writes an inline declaration. An inline declaration beats every
 * stylesheet rule except one marked `!important`, and imported pages carry
 * those: the Ghacem demo has
 * `.button, a.button, … { color: rgb(20,19,23) !important; background-color: rgb(218,165,99) !important }`
 * in a `<style>` of its own, so every colour change on its buttons landed in
 * the draft and showed nowhere — not on the canvas, not live (10 Nov 2026).
 *
 * Asked of the element itself rather than of the stylesheets: a CDN sheet may
 * not be readable, and the cascade is the browser's to decide. Each declaration
 * this change touches is tried plain and then `!important`; when the two give
 * different computed values something on the site is beating the plain one, and
 * that declaration is written flagged. Transitions are switched off for the
 * test, or a Webflow button's `transition: all .3s` reports the old colour both
 * times and hides the difference. The element's style is put back afterwards;
 * the editor writes the result in the usual way.
 *
 * Desktop only. A flagged inline declaration also beats the tablet and phone
 * rules for that property on that element, which are a stylesheet — the same
 * trade a page's own inline `!important` already makes.
 */
export function winOverSiteImportant(element: HTMLElement | null, before: string, next: string): string {
  const view = element?.ownerDocument?.defaultView;
  if (!element || !view) return next;
  const was = parseStyle(before);
  const now = parseStyle(next);
  const beaten = new Set<string>();
  const saved = element.getAttribute("style");
  try {
    const style = element.style;
    style.setProperty("transition", "none", "important");
    for (const [property, value] of Object.entries(now)) {
      if (property.startsWith("--") || property === "transition" || IMPORTANT.test(value)) continue;
      if ((was[property] ?? "").replace(IMPORTANT, "") === value) continue;
      style.setProperty(property, value);
      if (!style.getPropertyValue(property)) continue; // not a value this browser takes
      const plain = view.getComputedStyle(element).getPropertyValue(property);
      style.setProperty(property, value, "important");
      const forced = view.getComputedStyle(element).getPropertyValue(property);
      if (plain !== forced) beaten.add(property);
    }
  } catch {
    return next;
  } finally {
    if (saved === null) element.removeAttribute("style");
    else element.setAttribute("style", saved);
  }
  if (!beaten.size) return next;
  return writeStyle(Object.fromEntries(Object.entries(now).map(([property, value]) => [property, beaten.has(property) ? `${value} !important` : value])));
}
