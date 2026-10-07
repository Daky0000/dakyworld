/**
 * Which product this browser tab is.
 *
 * One build serves three hosts — os.dakyx.com (the company's own OS),
 * editor.dakyx.com (the Website Editor customers pay for) and app.dakyx.com
 * (their account) — and the server decides what each may reach
 * (`middleware/appSurface.ts`). This is the client's half: what the tab is
 * called, and what the sign-in screen says. It used to be decided in three
 * places from the hostname, and the sign-in screen did not ask at all, so a
 * customer who had just paid was greeted by "DakyXTech OS · Internal
 * Operations".
 */
export type Surface = "os" | "editor" | "app";

export function currentSurface(): Surface {
  const forced = import.meta.env.VITE_APP_SURFACE;
  if (forced === "editor" || forced === "app" || forced === "os") return forced;
  const host = typeof window === "undefined" ? "" : window.location.hostname;
  if (host === "editor.dakyx.com") return "editor";
  if (host === "app.dakyx.com") return "app";
  return "os";
}

/** What each product is called, in a tab title and on its sign-in screen. */
export const SURFACE_NAME: Record<Surface, string> = {
  os: "DakyXTech OS",
  editor: "DakyX Website Editor",
  app: "DakyX",
};

/** "Pages · DakyX Website Editor" — or just the product name when there is nothing more specific. */
export function setPageTitle(title?: string | null) {
  if (typeof document === "undefined") return;
  const product = SURFACE_NAME[currentSurface()];
  document.title = title ? `${title} · ${product}` : product;
}
