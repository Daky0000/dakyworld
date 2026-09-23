import { useEffect, useRef, useState, Suspense } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useWebsiteSites } from "./WebsiteGuard";
import { CLIENT_NAV, useWorkspaceMode } from "../lib/clientWorkspace";
import { Loading } from "./ui";

type NavEntry = { to: string; label: string; end?: boolean; needs?: string };
type NavGroup = { title: string; items: NavEntry[] };

const navGroups: NavGroup[] = [
  {
    title: "Workspace",
    items: [
      { to: "/", label: "Dashboard", end: true, needs: "dashboard.view" },
    ],
  },
  {
    title: "Pipeline",
    items: [
      { to: "/leads", label: "Leads", end: true, needs: "leads.view" },
      { to: "/hunts", label: "Global Hunts", needs: "leads.sources" },
      { to: "/lead-sources", label: "Lead Capture", needs: "leads.sources" },
      { to: "/leads/import", label: "Import CSV", needs: "leads.import" },
      { to: "/clients", label: "Clients", needs: "clients.view" },
    ],
  },
  {
    title: "Revenue & Deals",
    items: [
      { to: "/proposals", label: "Proposals", needs: "proposals.view" },
      { to: "/demos", label: "Demos", needs: "demos.view" },
      { to: "/concepts", label: "Concept Review", needs: "demos.view" },
      { to: "/projects", label: "Projects", needs: "projects.view" },
      { to: "/invoices", label: "Invoices", needs: "invoices.view" },
      { to: "/care-plans", label: "Care plans", needs: "retainers.view" },
    ],
  },
  {
    title: "Outreach",
    items: [
      { to: "/emails", label: "Cold Email", end: true, needs: "emails.view" },
      { to: "/inbox", label: "Unified Inbox", needs: "inbox.view" },
      { to: "/messages", label: "WhatsApp & SMS", needs: "messages.view" },
    ],
  },
  {
    title: "Workforce",
    items: [
      { to: "/agents", label: "Workforce Floor", end: true, needs: "agents.view" },
      { to: "/approvals", label: "Action Approvals", needs: "agents.approvals.view" },
      { to: "/rehearsals", label: "Rehearsal Room", needs: "agents.rehearsals.view" },
      { to: "/agents/tools", label: "Agent Tools", needs: "agents.tools" },
      { to: "/costs", label: "Model costs", needs: "agents.costs" },
    ],
  },
  {
    title: "Products & System",
    items: [
      { to: "/website/sites", label: "Client Portal", needs: "website.view" },
      { to: "/website", label: "Website Builder", needs: "website.view" },
      { to: "/products/pricing", label: "Product Pricing", needs: "website.view" },
      { to: "/team", label: "Team Access", needs: "team.view" },
      { to: "/settings", label: "Settings", needs: "settings.view" },
    ],
  },
];


export function Layout() {
  const { user, can, logout } = useAuth();
  const websites = useWebsiteSites();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const mobileRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [workspaceMode, setWorkspaceMode] = useWorkspaceMode(user?.external);
  const client = user?.external === true || workspaceMode === "client";

  const handleSetMode = (nextMode: "admin" | "client") => {
    setWorkspaceMode(nextMode);
    if (nextMode === "client") {
      if (!location.pathname.startsWith("/website")) {
        navigate("/website/sites");
      }
    } else {
      if (location.pathname === "/website/sites" || location.pathname === "/website/assets" || location.pathname === "/website/audit" || location.pathname === "/website/team") {
        navigate("/");
      }
    }
  };

  useEffect(() => {
    setMobileOpen(false);
    const group = navGroups.find(group => group.items.some(item => item.to === "/" ? location.pathname === "/" : item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)));
    if (group) setExpandedGroups(current => ({ ...current, [group.title]: true }));
  }, [location.pathname]);
  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    mobileRef.current?.querySelector<HTMLElement>("button, a, input")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
      if (event.key !== "Tab") return;
      const nodes = mobileRef.current?.querySelectorAll<HTMLElement>('a[href], button, input');
      if (!nodes?.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
      menuRef.current?.focus();
    };
  }, [mobileOpen]);
  const allowed = (item: NavEntry) => (item.to === "/website" || item.to === "/website/sites")
    ? Boolean(client || can("website.view") || websites.data?.length)
    : !client && (!item.needs || can(item.needs));
  const groups: NavGroup[] = client
    ? [{ title: "Your workspace", items: CLIENT_NAV.map(item => ({ to: item.to, label: item.label })) }]
    : navGroups.map(group => ({ ...group, items: group.items.filter(allowed) })).filter(group => group.items.length);
  const visibleGroups = groups.map(group => ({ ...group, items: group.items.filter(item => `${group.title} ${item.label}`.toLowerCase().includes(filter.toLowerCase())) })).filter(group => group.items.length);
  const current = groups.flatMap(group => group.items).filter(item => item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to)).sort((a, b) => b.to.length - a.to.length)[0];
  const fullBleed = /^\/website\/pages\//.test(location.pathname);
  if (fullBleed) return <div className="os-app flex h-screen flex-col overflow-hidden bg-cream text-ink"><Suspense fallback={<Loading />}><Outlet /></Suspense></div>;

  const navigation = (mobile = false) => <>
    <div className="os-brand">
      <img src="/brand/mark-on-dark-96.png" alt="Dakyworld" width={36} height={36} />
      <div><strong>{client ? "Dakyworld" : "Dakyworld OS"}</strong><span>{client ? "Website studio" : "Business workspace"}</span></div>
      {mobile && <button type="button" onClick={() => setMobileOpen(false)} className="os-nav-close">Close</button>}
    </div>
    {!user?.external && (
      <div className="px-3 pb-3">
        <div className="flex rounded-xl bg-[#161F2E] p-1 border border-[#354052]/60" role="group" aria-label="Workspace view mode">
          <button
            type="button"
            onClick={() => handleSetMode("admin")}
            className={`flex-1 rounded-lg py-1.5 text-center text-[11px] font-semibold transition ${
              workspaceMode === "admin"
                ? "bg-[#223251] text-white shadow-xs"
                : "text-[#A9B3C5] hover:text-white"
            }`}
          >
            Admin OS
          </button>
          <button
            type="button"
            onClick={() => handleSetMode("client")}
            className={`flex-1 rounded-lg py-1.5 text-center text-[11px] font-semibold transition ${
              workspaceMode === "client"
                ? "bg-lime text-ink font-bold shadow-xs"
                : "text-[#A9B3C5] hover:text-white"
            }`}
          >
            Client Portal
          </button>
        </div>
      </div>
    )}
    <div className="os-nav-search"><input aria-label="Find a workspace page" placeholder="Find a page" value={filter} onChange={event => setFilter(event.target.value)} /></div>
    <nav className="os-navigation" aria-label={mobile ? "Mobile navigation" : "Main navigation"}>
      {visibleGroups.map((group, index) => {
        const active = group.items.some(item => item.to === "/" ? location.pathname === "/" : item.end ? location.pathname === item.to : location.pathname.startsWith(item.to));
        const expanded = Boolean(filter.trim()) || (expandedGroups[group.title] ?? (active || group.title === "Workspace" || client));
        const groupId = `${mobile ? "mobile" : "desktop"}-nav-group-${index}`;
        return <section key={group.title} className={active ? "os-nav-section is-current" : "os-nav-section"}>
          <button type="button" className="os-nav-group-toggle" aria-expanded={expanded} aria-controls={groupId} onClick={() => setExpandedGroups(current => ({ ...current, [group.title]: !expanded }))}>
            <span>{group.title}</span><span className="os-nav-group-state">{expanded ? "Hide" : group.items.length}</span>
          </button>
          <div id={groupId} hidden={!expanded} className="os-nav-group-items">
            {group.items.map(item => <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `os-nav-link${isActive ? " is-active" : ""}`}>{item.label}</NavLink>)}
          </div>
        </section>;
      })}
      {!visibleGroups.length && <p className="os-nav-empty">No matching pages.</p>}
      {workspaceMode === "client" && !user?.external && (
        <div className="mt-4 px-1 pt-3 border-t border-[#293244]">
          <button
            type="button"
            onClick={() => handleSetMode("admin")}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#161F2E] px-3 py-2 text-xs font-semibold text-[#A9B3C5] border border-[#354052]/60 hover:bg-[#223251] hover:text-white transition"
          >
            <span>&larr;</span> Back to Admin OS
          </button>
        </div>
      )}
    </nav>
    {user && <div className="os-account"><div className="os-initials">{user.name.slice(0, 2).toUpperCase()}</div><div className="min-w-0 flex-1"><strong>{user.name}</strong><span>{user.roleName || user.role || user.email}</span></div><button type="button" onClick={() => void logout()}>Sign out</button></div>}
  </>;
  return <div className="os-app os-shell">
    <a href="#workspace" className="os-skip">Skip to content</a>
    <aside className="os-sidebar">{navigation()}</aside>
    {mobileOpen && <div className="os-mobile-layer"><div className="os-backdrop" onClick={() => setMobileOpen(false)} aria-hidden /><aside ref={mobileRef} className="os-mobile-nav" role="dialog" aria-modal="true" aria-label="Navigation">{navigation(true)}</aside></div>}
    <div className="os-viewport">
      <header className="os-topbar">
        <div className="flex min-w-0 items-center gap-4">
          <button ref={menuRef} type="button" className="os-menu-button" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}>Menu</button>
          <span className="os-workspace-label">{client ? "Client workspace" : "Workspace"}</span><span className="os-breadcrumb-divider">/</span><span className="truncate">{current?.label || "Detail"}</span>
          {!user?.external && (
            <div className="ml-2 hidden sm:flex items-center gap-1 rounded-full border border-line bg-white/90 px-1.5 py-0.5 text-xs shadow-2xs">
              <button
                type="button"
                onClick={() => handleSetMode("admin")}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                  workspaceMode === "admin" ? "bg-ink text-white" : "text-muted hover:text-ink"
                }`}
              >
                Admin
              </button>
              <button
                type="button"
                onClick={() => handleSetMode("client")}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                  workspaceMode === "client" ? "bg-lime text-ink font-bold" : "text-muted hover:text-ink"
                }`}
              >
                Client Portal
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-4">
          {location.pathname !== "/" && <button className="os-text-link" onClick={() => navigate(-1)}>Back</button>}
          <span className="os-topbar-date">{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date())}</span>
        </div>
      </header>
      <main id="workspace" tabIndex={-1} className="os-workspace"><Suspense fallback={<Loading rows={5} />}><Outlet /></Suspense></main>
      <footer className="os-workspace-footer"><span>Dakyworld OS</span><span>{client ? "Your digital workspace" : "Built for considered work."}</span></footer>
    </div>
  </div>;
}
