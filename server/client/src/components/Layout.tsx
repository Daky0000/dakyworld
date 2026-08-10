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
    <div className="min-h-screen bg-ivory text-ink">
      <header className="border-b border-ink/10 bg-white/70 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center border border-ink/20 bg-ink text-ivory">
              <span className="font-serif text-sm font-semibold">D</span>
            </span>
            <div className="leading-none">
              <div className="font-mono text-xs font-medium uppercase tracking-[.18em]">Dakyworld OS</div>
              <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">Internal Operations</div>
            </div>
          </div>
          <nav className="flex items-center gap-6">
            {visibleNav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `font-mono text-xs uppercase tracking-[.14em] transition ${
                    isActive ? "text-ink" : "text-ink/50 hover:text-ink"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
            <span className="h-4 w-px bg-ink/15" aria-hidden />
            <div className="flex items-center gap-3">
              <span className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40" title={user?.email}>
                {user?.name}
              </span>
              <button
                type="button"
                onClick={() => void logout()}
                className="font-mono text-xs uppercase tracking-[.14em] text-ink/50 transition hover:text-ink"
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
            className="mb-5 inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.14em] text-ink/45 transition hover:text-ink"
          >
            <span aria-hidden>←</span> Back
          </button>
        )}
        <Outlet />
      </main>
    </div>
  );
}
