import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

type NavItem = {
  to: string;
  label: string;
  end?: boolean;
  ownerOnly?: boolean;
  roles?: string[];
  /** Renders as a dropdown. `to` is where the group's own tab goes. */
  children?: NavItem[];
};

const navItems: NavItem[] = [
  { to: "/", label: "Dashboard", end: true },
  // Getting leads in is three screens — the list, the scrapers, the importer —
  // and they were three top-level tabs competing with Proposals and Invoices
  // for the same row. They're one job, so they're one menu.
  //
  // Configuring scrapers spends money on Apify, and importing spends Anthropic
  // credits and reaches into a Google account, so the API restricts both to the
  // Owner. Hiding those entries keeps the rest of the team out of a 403 while
  // still leaving them the list itself.
  {
    to: "/leads",
    label: "Leads",
    children: [
      { to: "/leads", label: "All leads", end: true },
      { to: "/lead-sources", label: "Capture", ownerOnly: true },
      { to: "/leads/import", label: "Import", ownerOnly: true },
    ],
  },
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
  // Raising an agent's autonomy is the one action here that lets software act
  // on a client without being asked, so it sits with Settings behind the Owner.
  { to: "/agents", label: "Agents", ownerOnly: true },
  { to: "/settings", label: "Settings", ownerOnly: true },
];

/**
 * A nav entry with a menu under it. Opens on click rather than hover — a hover
 * menu over a working tool fires every time you cross it on the way somewhere
 * else.
 */
function NavGroup({ item }: { item: NavItem }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const ref = useRef<HTMLDivElement>(null);
  const children = item.children ?? [];
  const active = children.some((child) => (child.end ? location.pathname === child.to : location.pathname.startsWith(child.to)));

  // Close on an outside click or Escape, the same way Drawer does.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-semibold transition ${
          active ? "bg-ink text-white" : "text-muted hover:bg-ink/[.05] hover:text-ink"
        }`}
      >
        {item.label}
        <span aria-hidden className={`text-[9px] transition ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+6px)] z-50 min-w-[180px] overflow-hidden rounded-xl border border-line bg-white py-1 shadow-lg shadow-ink/5">
          {children.map((child) => (
            <NavLink
              key={child.to}
              to={child.to}
              end={child.end}
              className={({ isActive }) =>
                `block px-3.5 py-2 text-[12px] font-semibold transition ${
                  isActive ? "bg-ink/[.06] text-ink" : "text-muted hover:bg-ink/[.03] hover:text-ink"
                }`
              }
            >
              {child.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const allowed = (item: NavItem) =>
    (!item.ownerOnly || user?.role === "OWNER") &&
    (!item.roles || (user?.role !== undefined && item.roles.includes(user.role)));
  // Children are gated too, so a Developer sees "All leads" under Leads and
  // not Capture or Import — the same 403s the API would return.
  const visibleNav = navItems
    .filter(allowed)
    .map((item) => (item.children ? { ...item, children: item.children.filter(allowed) } : item));
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
            {visibleNav.map((item) =>
              item.children ? (
                <NavGroup key={item.label} item={item} />
              ) : (
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
              ),
            )}
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
