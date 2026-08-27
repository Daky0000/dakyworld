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
   * A screen that does not exist yet.
   *
   * Listed here rather than left out, because the build order is the plan's and
   * the tabs arrive in it — but **not rendered**, because a tab that opens onto
   * an empty shell teaches somebody the product is broken rather than that the
   * feature is coming.
   */
  unbuilt?: boolean;
};

export const WEBSITE_TABS: Tab[] = [
  { to: "/website", label: "Overview", end: true, needs: "website.view" },
  { to: "/website/sites", label: "Sites", needs: "website.view" },
  { to: "/website/assets", label: "Assets", needs: "website.edit", unbuilt: true },
  { to: "/website/ai", label: "AI Assistant", needs: "website.edit", unbuilt: true },
  { to: "/website/team", label: "Team & Permissions", needs: "website.manage", unbuilt: true },
  { to: "/website/audit", label: "Audit Log", needs: "website.manage", unbuilt: true },
  { to: "/website/settings", label: "Settings", needs: "website.manage", unbuilt: true },
  { to: "/website/billing", label: "License & Billing", needs: "website.manage", unbuilt: true },
];

export function WebsiteLayout() {
  const { can } = useAuth();
  const location = useLocation();
  const tabs = WEBSITE_TABS.filter((tab) => !tab.unbuilt && (!tab.needs || can(tab.needs)));

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
          </NavLink>
        ))}
      </div>
      <Outlet />
    </div>
  );
}
