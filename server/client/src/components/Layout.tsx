import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

type NavItem = { to: string; label: string; end?: boolean; ownerOnly?: boolean; roles?: string[] };

const navItems: NavItem[] = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/leads", label: "Leads" },
  // Configuring scrapers spends money on Apify, and importing spends Anthropic
  // credits and reaches into a Google account, so the API restricts both to the
  // Owner. Hiding the tabs keeps the rest of the team out of a 403.
  { to: "/lead-sources", label: "Capture", ownerOnly: true },
  { to: "/leads/import", label: "Import", ownerOnly: true },
  { to: "/proposals", label: "Proposals" },
  { to: "/projects", label: "Projects" },
  { to: "/invoices", label: "Invoices" },
  // Care plans decide what recurring money moves and when, so the API limits
  // them to the Owner and Finance — same reasoning as Capture and Import.
  { to: "/care-plans", label: "Retainers", roles: ["OWNER", "OPERATIONS_FINANCE"] },
  // Writing to a client under the company's name isn't a junior privilege —
  // the API restricts it the same way, so hiding the tab avoids a 403.
  { to: "/emails", label: "Email", roles: ["OWNER", "OPERATIONS_FINANCE", "PROJECT_MANAGER"] },
  { to: "/clients", label: "Clients" },
  { to: "/settings", label: "Settings", ownerOnly: true },
];

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const visibleNav = navItems.filter(
    (item) =>
      (!item.ownerOnly || user?.role === "OWNER") &&
      (!item.roles || (user?.role !== undefined && item.roles.includes(user.role))),
  );
  // Every page except the dashboard is somewhere you arrived from somewhere
  // else, so every one of them gets a way back that doesn't mean hunting for
  // the browser chrome or guessing which nav tab you came in through.
  const canGoBack = location.pathname !== "/";
  return (
    <div className="min-h-screen bg-cream text-ink">
      {/* Sticky, like the website's shell — navigation is the one thing you
          should never have to scroll back up for. Light rather than dark
          glass: this is a working tool, not a landing page. */}
      <header className="sticky top-0 z-40 border-b border-line bg-cream/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-6 py-3.5">
          <div className="flex items-center gap-3">
            <img src="/brand/mark-on-light-96.png" alt="" width={34} height={34} className="h-[34px] w-[34px]" />
            <div className="leading-none">
              <div className="font-display text-[15px] font-bold tracking-[-.03em]">
                Dakyworld OS
              </div>
              <div className="mt-1 font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">Internal Operations</div>
            </div>
          </div>
          <nav className="flex items-center gap-1.5">
            {visibleNav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `relative rounded-full px-3 py-1.5 text-[12px] font-semibold transition ${
                    isActive ? "bg-ink text-white" : "text-muted hover:bg-ink/[.05] hover:text-ink"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
            <span className="mx-2 h-5 w-px bg-line" aria-hidden />
            <div className="flex items-center gap-3">
              <span className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/55" title={user?.email}>
                {user?.name}
              </span>
              <button
                type="button"
                onClick={() => void logout()}
                className="rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold text-muted transition hover:border-ink/40 hover:text-ink"
              >
                Sign out
              </button>
            </div>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-10">
        {canGoBack && (
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="mb-5 inline-flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-[11px] font-bold text-muted transition hover:border-ink/40 hover:text-ink"
          >
            <span aria-hidden>←</span> Back
          </button>
        )}
        <Outlet />
      </main>
    </div>
  );
}
