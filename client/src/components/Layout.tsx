import { NavLink, Outlet } from "react-router-dom";

const navItems = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/leads", label: "Leads" },
  { to: "/proposals", label: "Proposals" },
  { to: "/projects", label: "Projects" },
  { to: "/invoices", label: "Invoices" },
  { to: "/clients", label: "Clients" },
];

export function Layout() {
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
            {navItems.map((item) => (
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
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-10">
        <Outlet />
      </main>
    </div>
  );
}
