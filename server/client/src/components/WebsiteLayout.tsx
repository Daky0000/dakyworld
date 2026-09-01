import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";

/**
 * The Website Builder's own navigation, one level below the OS menu.
 *
 * The builder has ten screens and the OS has one row of tabs, so they cannot
 * both live there. The system plan draws it as a sub-menu nested under a main
 * menu item, which in a sidebar is an indent; here the main menu is a horizontal
 * bar, so the second level is a strip inside the product rather than a ten-item
 * dropdown nobody could aim at.
 *
 * That is also the honest shape of the thing. This is no longer one screen for
 * changing a heading — it is a product with a work path (Sites → Pages →
 * Editor) and a management path (everything else), and the strip is what says
 * so on arrival.
 *
 * The editor itself is deliberately outside this layout: it takes the whole
 * window, and a page of somebody's website underneath two rows of chrome is not
 * the page.
 */

type Tab = {
  to: string;
  label: string;
  end?: boolean;
  needs?: string;
  /**
   * A screen that is planned and not built.
   *
   * Rendered, marked, and reachable — the opposite of what a first pass at this
   * did, and the reversal was deliberate. Hiding them keeps the product tidy and
   * makes the plan invisible: the only record of a ten-screen product would be a
   * PDF nobody opens twice, and a screen nobody can see is a screen that gets
   * forgotten.
   *
   * What makes that safe is that these are not empty shells. Each one says what
   * it will hold and what it is waiting on (`components/PlannedScreen.tsx`), so
   * it reads as a plan rather than as a broken page — and all of them are gated
   * on `website.manage`, so a client with editing rights never sees one.
   */
  unbuilt?: boolean;
};

/**
 * The plan's §14.2 menu, in its order, complete.
 *
 * Everything unbuilt is gated on `website.manage` rather than on the permission
 * it will eventually want — a client should not be shown the shape of a feature
 * they cannot use yet.
 */
export const WEBSITE_TABS: Tab[] = [
  { to: "/website", label: "Overview", end: true, needs: "website.view" },
  { to: "/website/sites", label: "Sites", needs: "website.view" },
  { to: "/website/assets", label: "Assets", needs: "website.manage", unbuilt: true },
  { to: "/website/ai", label: "AI Assistant", needs: "website.manage", unbuilt: true },
  { to: "/website/updates", label: "Updates", needs: "website.manage", unbuilt: true },
  { to: "/website/team", label: "Team & Permissions", needs: "website.manage", unbuilt: true },
  { to: "/website/audit", label: "Audit Log", needs: "website.manage", unbuilt: true },
  { to: "/website/settings", label: "Settings", needs: "website.manage", unbuilt: true },
  { to: "/website/billing", label: "License & Billing", needs: "website.manage", unbuilt: true },
];

export function WebsiteLayout() {
  const { can } = useAuth();
  const location = useLocation();
  const tabs = WEBSITE_TABS.filter((tab) => !tab.needs || can(tab.needs));

  // A site's own pages live under /website/sites/:id, so the Sites tab stays lit
  // while somebody is inside one. Without this, opening a site makes the strip
  // go blank and the screen reads as somewhere else entirely.
  const isActive = (tab: Tab) => (tab.end ? location.pathname === tab.to : location.pathname.startsWith(tab.to));

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-center gap-1 border-b border-line">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={`-mb-px border-b-2 px-3 py-2.5 text-[12px] font-semibold transition ${
              isActive(tab) ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {tab.label}
            {/* A dot rather than the word "planned": the label is what somebody
                aims at, and three extra words on six of nine tabs would make the
                two working ones harder to find. The screen itself says the rest. */}
            {tab.unbuilt && <span aria-label=" (planned)" title="Planned — not built yet" className="ml-1.5 text-muted">•</span>}
          </NavLink>
        ))}
      </div>
      <Outlet />
    </div>
  );
}
