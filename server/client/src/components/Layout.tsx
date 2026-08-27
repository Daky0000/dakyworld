import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

type NavItem = {
  to: string;
  label: string;
  end?: boolean;
  /**
   * What the API asks for on that screen's own routes. A tab whose permission
   * this person lacks is not rendered.
   *
   * This used to be `ownerOnly?: boolean` plus `roles?: string[]` — a second
   * copy of the permission model, maintained by hand against twenty
   * `requireRole` lines on the server, and wrong the moment either side moved.
   * Now there is one source of truth, the server resolves it, and this is a
   * lookup rather than a rule.
   */
  needs?: string;
  /** Renders as a dropdown. `to` is where the group's own tab goes. */
  children?: NavItem[];
};

const navItems: NavItem[] = [
  { to: "/", label: "Dashboard", end: true, needs: "dashboard.view" },
  // Getting leads in is three screens — the list, the scrapers, the importer —
  // and they were three top-level tabs competing with Proposals and Invoices
  // for the same row. They're one job, so they're one menu.
  {
    to: "/leads",
    label: "Leads",
    needs: "leads.view",
    children: [
      { to: "/leads", label: "All leads", end: true, needs: "leads.view" },
      { to: "/lead-sources", label: "Capture", needs: "leads.sources" },
      { to: "/leads/import", label: "Import", needs: "leads.import" },
    ],
  },
  { to: "/proposals", label: "Proposals", needs: "proposals.view" },
  { to: "/demos", label: "Demos", needs: "demos.view" },
  { to: "/projects", label: "Projects", needs: "projects.view" },
  { to: "/invoices", label: "Invoices", needs: "invoices.view" },
  { to: "/care-plans", label: "Retainers", needs: "retainers.view" },
  // Email and the phone channels are one job — reaching somebody — and which
  // one is even possible is decided per lead by whether an address exists. So
  // they are one menu rather than two tabs competing for the same row.
  {
    to: "/emails",
    label: "Outreach",
    needs: "emails.view",
    children: [
      { to: "/emails", label: "Email", end: true, needs: "emails.view" },
      { to: "/inbox", label: "Inbox", needs: "inbox.view" },
      { to: "/messages", label: "WhatsApp & SMS", needs: "messages.view" },
    ],
  },
  { to: "/clients", label: "Clients", needs: "clients.view" },
  // "Products" rather than "Website Builder" at this level, and it is not a
  // flourish: the builder is the first thing this company has built to sell
  // rather than to use, and the next one needs a shelf to go on. Under it, the
  // builder carries its own sub-navigation — see components/WebsiteLayout.tsx.
  {
    to: "/website",
    label: "Products",
    needs: "website.view",
    children: [{ to: "/website", label: "Website Builder", needs: "website.view" }],
  },
  {
    to: "/agents",
    label: "Agents",
    needs: "agents.view",
    children: [
      { to: "/agents", label: "Workforce", end: true, needs: "agents.view" },
      { to: "/approvals", label: "Approvals", needs: "agents.approvals.view" },
      // Watching the whole floor work one website at once. It belongs under
      // Agents rather than beside Leads: the subject is the workforce, and the
      // website is only what you point it at.
      { to: "/rehearsals", label: "Rehearsal", needs: "agents.rehearsals.view" },
      { to: "/agents/tools", label: "Tools", needs: "agents.tools" },
      // What the floor above costs to run. Under Agents rather than beside the
      // money screens on purpose: Invoices is what clients owe us, this is what
      // the workforce spends, and putting them together would invite somebody
      // to read one as the other.
      { to: "/costs", label: "Costs", needs: "agents.costs" },
    ],
  },
  { to: "/team", label: "Team", needs: "team.view" },
  { to: "/settings", label: "Settings", needs: "settings.view" },
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
  const { user, can, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const allowed = (item: NavItem) => !item.needs || can(item.needs);
  // Children are gated too, so somebody with read-only Leads sees "All leads"
  // and not Capture or Import — the same 403s the API would return.
  //
  // A group whose children are all hidden is dropped rather than left as a
  // menu that opens onto nothing.
  const visibleNav = navItems
    .filter(allowed)
    .map((item) => (item.children ? { ...item, children: item.children.filter(allowed) } : item))
    .filter((item) => !item.children || item.children.length > 0);
  // Every page except the dashboard is somewhere you arrived from somewhere
  // else, so every one of them gets a way back that doesn't mean hunting for
  // the browser chrome or guessing which nav tab you came in through.
  const canGoBack = location.pathname !== "/";
  // One screen wants the whole window: the website editor puts a page of the
  // real site beside its panel, and a page of a website inside a centred
  // 1280px column with forty pixels of padding round it is not that page.
  // Everywhere else keeps the reading column.
  const fullBleed = /^\/website\/pages\//.test(location.pathname);
  return (
    <div className={fullBleed ? "flex h-screen flex-col overflow-hidden bg-cream text-ink" : "min-h-screen bg-cream text-ink"}>
      {/* Sticky, like the website's shell — navigation is the one thing you
          should never have to scroll back up for. Light rather than dark
          glass: this is a working tool, not a landing page. */}
      <header
        className={
          fullBleed
            ? "z-40 flex-none border-b border-line bg-cream"
            : "sticky top-0 z-40 border-b border-line bg-cream/85 backdrop-blur-xl"
        }
      >
        <div className={`flex items-center justify-between gap-6 px-6 py-3.5 ${fullBleed ? "" : "mx-auto max-w-7xl"}`}>
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
              <span className="max-w-[140px] truncate whitespace-nowrap font-mono text-[10px] uppercase tracking-[.14em] text-ink/55" title={user?.email}>
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
      <main className={fullBleed ? "min-h-0 flex-1" : "mx-auto max-w-7xl px-6 py-10"}>
        {canGoBack && !fullBleed && (
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
