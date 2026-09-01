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
      // Above Capture on purpose. Capture answers "how do we search"; a hunt
      // answers "why that search", and the second is the one somebody should
      // meet first — a search with no reason behind it is what fills a pipeline
      // with businesses nobody can explain.
      { to: "/hunts", label: "Hunts", needs: "leads.sources" },
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
 * §18: a tab is quiet white until it is the one you are on, and then it is
 * marked by a 2px lime rule rather than filled in.
 *
 * The filled ink pill this replaces was the single loudest object in the header
 * and it was spent on saying "you are here", which is the one thing the page
 * behind it already says. Underlining it gives the same information back for
 * about a tenth of the ink, which is what leaves room for lime to still mean
 * something when it turns up on an actual action.
 */
function tabClass(isActive: boolean) {
  return `relative rounded-full px-2.5 py-1.5 text-[12px] font-semibold transition ${
    isActive ? "text-white" : "text-white/60 hover:text-white"
  }`;
}

function ActiveRule({ show }: { show: boolean }) {
  return (
    <span
      aria-hidden
      className={`absolute inset-x-2.5 -bottom-[9px] h-[2px] origin-left rounded-full bg-lime transition-transform duration-300 ${
        show ? "scale-x-100" : "scale-x-0"
      }`}
    />
  );
}

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
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={`${tabClass(active)} flex items-center gap-1`}>
        {item.label}
        <span aria-hidden className={`text-[9px] transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
        <ActiveRule show={active} />
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+12px)] z-50 min-w-[180px] overflow-hidden rounded-xl border border-white/12 bg-ink py-1 shadow-menu">
          {children.map((child) => (
            <NavLink
              key={child.to}
              to={child.to}
              end={child.end}
              className={({ isActive }) =>
                `block px-3.5 py-2 text-[12px] font-semibold transition ${
                  isActive ? "bg-white/10 text-white" : "text-white/60 hover:bg-white/[.06] hover:text-white"
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

/**
 * §43. Below the width where thirteen sections fit on one line, the same
 * hierarchy opens as a dark panel instead of being cut off by the edge of the
 * window.
 *
 * It is worth being blunt about what this replaces: there was no mobile
 * treatment at all. The nav was a single non-wrapping flex row, so on a phone
 * it forced the document about 1300px wide and every screen in the product
 * scrolled sideways — the dashboard figures, the lead tables, the buttons.
 */
function MobileNav({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div className="xl:hidden" ref={ref}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 text-white transition hover:bg-white/10"
      >
        <span aria-hidden className="relative block h-[9px] w-4">
          <span className={`absolute left-0 h-[1.5px] w-4 rounded bg-current transition-all ${open ? "top-[4px] rotate-45" : "top-0"}`} />
          <span className={`absolute left-0 h-[1.5px] w-4 rounded bg-current transition-all ${open ? "top-[4px] -rotate-45" : "top-[7px]"}`} />
        </span>
      </button>

      {open && (
        <nav className="absolute right-4 top-[calc(100%+10px)] z-50 max-h-[calc(100vh-6rem)] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-white/12 bg-ink p-2 shadow-menu">
            {items.map((item) =>
              item.children ? (
                <div key={item.label} className="border-b border-white/[.08] py-2 last:border-0">
                  <div className="px-3 pb-1 font-mono text-[10px] uppercase tracking-[.14em] text-white/50">{item.label}</div>
                  {item.children.map((child) => (
                    <NavLink
                      key={child.to}
                      to={child.to}
                      end={child.end}
                      className={({ isActive }) =>
                        `block rounded-xl px-3 py-2.5 text-[13px] font-semibold transition ${
                          isActive ? "bg-white/10 text-white" : "text-white/60 hover:bg-white/[.06] hover:text-white"
                        }`
                      }
                    >
                      {child.label}
                    </NavLink>
                  ))}
                </div>
              ) : (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `block rounded-xl px-3 py-2.5 text-[13px] font-semibold transition ${
                      isActive ? "bg-white/10 text-white" : "text-white/60 hover:bg-white/[.06] hover:text-white"
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ),
            )}
        </nav>
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
      {/* §16: the canonical Dakyworld header is a dark glass shell, and this is
          the one place in the OS where the brand can carry its own weight
          without getting in the way of the work. It is also what §04's colour
          ratio asks for — a fifth of a screen in ink — on a product that was
          otherwise white cards on cream from edge to edge, and read like any
          other admin panel because of it.

          Full-bleed rather than the website's floating rounded bar: the editor
          runs the window to its edges, and a pill hovering over a page of
          somebody's live site would be a landing-page device in a workshop. */}
      <header
        className={
          fullBleed
            ? "relative z-40 flex-none border-b border-white/10 bg-ink"
            : "sticky top-0 z-40 border-b border-white/10 bg-ink/95 backdrop-blur-xl"
        }
      >
        <div className={`flex items-center justify-between gap-6 px-4 py-3 sm:px-6 ${fullBleed ? "" : "mx-auto max-w-7xl"}`}>
          <div className="flex min-w-0 items-center gap-3">
            <img src="/brand/mark-on-dark-96.png" alt="" width={32} height={32} className="h-8 w-8 shrink-0" />
            <div className="min-w-0 leading-none">
              <div className="truncate font-display text-[15px] font-bold tracking-[-.03em] text-white">
                Dakyworld OS
              </div>
              <div className="mt-1 hidden font-mono text-[10px] uppercase tracking-[.14em] text-white/55 sm:block">
                Internal Operations
              </div>
            </div>
          </div>

          {/* Thirteen sections fit on one line from 1280px up and not below it,
              so that is exactly where the line stops being one. */}
          <nav className="hidden shrink-0 items-center gap-0.5 xl:flex">
            {visibleNav.map((item) =>
              item.children ? (
                <NavGroup key={item.label} item={item} />
              ) : (
                <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => tabClass(isActive)}>
                  {({ isActive }) => (
                    <>
                      {item.label}
                      <ActiveRule show={isActive} />
                    </>
                  )}
                </NavLink>
              ),
            )}
          </nav>

          <div className="flex shrink-0 items-center gap-3">
            <span
              className="hidden max-w-[140px] shrink-0 truncate whitespace-nowrap font-mono text-[10px] uppercase tracking-[.14em] text-white/50 lg:block"
              title={user?.email}
            >
              {user?.name}
            </span>
            <button
              type="button"
              onClick={() => void logout()}
              className="hidden shrink-0 whitespace-nowrap rounded-full border border-white/20 px-3 py-1.5 text-[12px] font-semibold text-white/70 transition hover:border-white/40 hover:text-white sm:block"
            >
              Sign out
            </button>
            <MobileNav items={visibleNav} />
          </div>
        </div>
      </header>

      <main className={fullBleed ? "min-h-0 flex-1" : "mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10"}>
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
