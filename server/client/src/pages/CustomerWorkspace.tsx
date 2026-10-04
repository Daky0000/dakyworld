import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";

interface SiteItem {
  id: string;
  name: string;
  subdomain: string;
  customDomain?: string | null;
  publishedAt?: string | null;
  status?: string;
}

export function CustomerWorkspace() {
  const { user, logout } = useAuth();
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [loadingSites, setLoadingSites] = useState(true);

  useEffect(() => {
    let active = true;
    api.get<SiteItem[]>("/website/sites")
      .then((data) => {
        if (active) setSites(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (active) setSites([]);
      })
      .finally(() => {
        if (active) setLoadingSites(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const editorUrl = window.location.hostname.includes("localhost")
    ? "/website/sites"
    : "https://editor.dakyx.com";

  return (
    <div className="min-h-screen bg-[#08101F] text-[#F4F5F0]">
      {/* Top Navigation */}
      <header className="border-b border-[#DFE4EB]/10 bg-[#0B0A16]/80 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/" className="flex items-center gap-2">
              <span className="font-display font-bold text-xl tracking-tight text-white">
                Daky<span className="text-[#3157FF]">X</span>Tech
              </span>
              <span className="text-[10px] tracking-widest font-mono uppercase bg-[#3157FF]/20 text-[#6490FF] px-2 py-0.5 rounded border border-[#3157FF]/30">
                Workspace
              </span>
            </Link>
          </div>

          <div className="flex items-center gap-4 text-sm">
            <div className="hidden sm:flex items-center gap-2 text-xs font-mono text-[#69758A]">
              <span className="inline-block w-2 h-2 rounded-full bg-[#B8FF3D] animate-pulse"></span>
              <span>{user?.email ?? "workspace-member"}</span>
            </div>
            <button
              onClick={() => logout()}
              className="text-xs font-medium px-3 py-1.5 rounded-lg border border-[#DFE4EB]/15 hover:border-red-400/50 hover:text-red-400 transition"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-12">
        {/* Workspace Hero */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-[#DFE4EB]/10">
          <div>
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-mono bg-[#3157FF]/10 text-[#6FE4FF] border border-[#3157FF]/30 mb-3">
              <span>CANONICAL IDENTITY</span>
              <span>•</span>
              <span>dakyx.com</span>
            </div>
            <h1 className="text-3xl sm:text-4xl font-display font-medium text-white tracking-tight">
              Customer Workspace & Product Launcher
            </h1>
            <p className="mt-2 text-sm sm:text-base text-[#69758A] max-w-2xl leading-relaxed">
              Manage your DakyX products, organizations, publishing pipelines, and enterprise entitlements from one central control plane.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <a
              href={editorUrl}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#3157FF] hover:bg-[#6490FF] text-white font-medium text-sm transition shadow-lg shadow-[#3157FF]/25"
            >
              <span>Launch Website Editor</span>
              <span aria-hidden="true">&rarr;</span>
            </a>
          </div>
        </div>

        {/* Product Launcher Grid */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-xl font-medium text-white">Your DakyX Products</h2>
            <span className="text-xs font-mono text-[#69758A]">Shared Identity • Independent Deployments</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Website Editor Card */}
            <div className="rounded-2xl border border-[#3157FF]/40 bg-gradient-to-b from-[#3157FF]/10 to-transparent p-6 flex flex-col justify-between relative overflow-hidden group hover:border-[#3157FF] transition">
              <div className="absolute top-0 right-0 p-4">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-mono bg-[#B8FF3D]/15 text-[#B8FF3D] border border-[#B8FF3D]/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#B8FF3D]"></span>
                  Active Entitlement
                </span>
              </div>

              <div className="space-y-4 pt-2">
                <div className="w-12 h-12 rounded-xl bg-[#3157FF]/20 border border-[#3157FF]/40 flex items-center justify-center text-[#6FE4FF]">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                  </svg>
                </div>

                <div>
                  <h3 className="font-display text-lg font-medium text-white">DakyX Website Editor</h3>
                  <p className="text-xs font-mono text-[#6490FF] mt-0.5">editor.dakyx.com</p>
                  <p className="mt-2 text-xs text-[#69758A] leading-relaxed">
                    Visual in-place website editing, template compilation, Cloudflare R2 asset streaming, and GitHub Pages continuous publishing.
                  </p>
                </div>

                <div className="pt-2 border-t border-[#DFE4EB]/10 flex flex-wrap gap-2 text-[11px] font-mono text-[#69758A]">
                  <span className="px-2 py-0.5 rounded bg-white/5">Visual Inspector</span>
                  <span className="px-2 py-0.5 rounded bg-white/5">Custom Domains</span>
                  <span className="px-2 py-0.5 rounded bg-white/5">Audit Hardened</span>
                </div>
              </div>

              <div className="mt-6 pt-4 border-t border-[#DFE4EB]/10">
                <a
                  href={editorUrl}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-[#3157FF] hover:bg-[#6490FF] text-white text-xs font-medium transition"
                >
                  Open Editor
                  <span aria-hidden="true">&rarr;</span>
                </a>
              </div>
            </div>

            {/* Workflow Automations Card */}
            <div className="rounded-2xl border border-[#DFE4EB]/10 bg-[#0B0A16]/50 p-6 flex flex-col justify-between relative overflow-hidden group hover:border-[#DFE4EB]/25 transition">
              <div className="absolute top-0 right-0 p-4">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-mono bg-white/5 text-[#69758A] border border-white/10">
                  Phase 2 • Core-Gated
                </span>
              </div>

              <div className="space-y-4 pt-2">
                <div className="w-12 h-12 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-[#69758A]">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>

                <div>
                  <h3 className="font-display text-lg font-medium text-white">DakyX Automations</h3>
                  <p className="text-xs font-mono text-[#69758A] mt-0.5">automate.dakyx.com</p>
                  <p className="mt-2 text-xs text-[#69758A] leading-relaxed">
                    Event-driven workflows, webhook receivers, WhatsApp/SMS bridges, and autonomous task queues running on isolated worker pools.
                  </p>
                </div>

                <div className="pt-2 border-t border-[#DFE4EB]/10 flex flex-wrap gap-2 text-[11px] font-mono text-[#69758A]">
                  <span className="px-2 py-0.5 rounded bg-white/5">Event Outbox</span>
                  <span className="px-2 py-0.5 rounded bg-white/5">Webhooks</span>
                  <span className="px-2 py-0.5 rounded bg-white/5">Redis Lease</span>
                </div>
              </div>

              <div className="mt-6 pt-4 border-t border-[#DFE4EB]/10">
                <button
                  disabled
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-white/5 text-[#69758A] text-xs font-medium cursor-not-allowed"
                >
                  Entitlement Pending
                </button>
              </div>
            </div>

            {/* Audience Analytics Card */}
            <div className="rounded-2xl border border-[#DFE4EB]/10 bg-[#0B0A16]/50 p-6 flex flex-col justify-between relative overflow-hidden group hover:border-[#DFE4EB]/25 transition">
              <div className="absolute top-0 right-0 p-4">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-mono bg-white/5 text-[#69758A] border border-white/10">
                  Preview Ready
                </span>
              </div>

              <div className="space-y-4 pt-2">
                <div className="w-12 h-12 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-[#6FE4FF]/80">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </div>

                <div>
                  <h3 className="font-display text-lg font-medium text-white">DakyX Analytics</h3>
                  <p className="text-xs font-mono text-[#69758A] mt-0.5">analytics.dakyx.com</p>
                  <p className="mt-2 text-xs text-[#69758A] leading-relaxed">
                    Zero-cookie visitor telemetry, geographic provenance tracking, conversion funnels, and real-time event analytics.
                  </p>
                </div>

                <div className="pt-2 border-t border-[#DFE4EB]/10 flex flex-wrap gap-2 text-[11px] font-mono text-[#69758A]">
                  <span className="px-2 py-0.5 rounded bg-white/5">GeoIP2 City</span>
                  <span className="px-2 py-0.5 rounded bg-white/5">Zero Cookies</span>
                  <span className="px-2 py-0.5 rounded bg-white/5">Live Sessions</span>
                </div>
              </div>

              <div className="mt-6 pt-4 border-t border-[#DFE4EB]/10">
                <a
                  href="/website/audit"
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-medium transition"
                >
                  View Telemetry Audit
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* Managed Sites Section */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-xl font-medium text-white">Managed Websites</h2>
              <p className="text-xs text-[#69758A] mt-0.5">Websites deployed and editable under your organization</p>
            </div>
            <a
              href={`${editorUrl}`}
              className="text-xs font-medium text-[#6490FF] hover:text-[#6FE4FF] transition"
            >
              + Create or Import Site
            </a>
          </div>

          {loadingSites ? (
            <div className="rounded-2xl border border-[#DFE4EB]/10 bg-[#0B0A16]/30 p-8 text-center text-xs font-mono text-[#69758A]">
              Loading managed sites...
            </div>
          ) : sites.length === 0 ? (
            <div className="rounded-2xl border border-[#DFE4EB]/10 bg-[#0B0A16]/30 p-8 text-center space-y-3">
              <p className="text-sm text-[#69758A]">No sites connected to this workspace yet.</p>
              <a
                href={editorUrl}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#3157FF] text-white text-xs font-medium"
              >
                Open Editor to Setup Your First Website &rarr;
              </a>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {sites.map((site) => (
                <div
                  key={site.id}
                  className="rounded-xl border border-[#DFE4EB]/10 bg-[#0B0A16]/60 p-5 space-y-3 hover:border-[#3157FF]/40 transition"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="font-medium text-white text-sm">{site.name}</h4>
                      <p className="text-xs font-mono text-[#6490FF]">{site.customDomain || `${site.subdomain}.dakyx.com`}</p>
                    </div>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-[#B8FF3D]/10 text-[#B8FF3D] border border-[#B8FF3D]/25">
                      LIVE
                    </span>
                  </div>

                  <div className="text-xs text-[#69758A] flex items-center justify-between pt-2 border-t border-[#DFE4EB]/10">
                    <span>Published: {site.publishedAt ? new Date(site.publishedAt).toLocaleDateString() : "Draft"}</span>
                    <a
                      href={editorUrl}
                      className="font-medium text-[#6FE4FF] hover:underline"
                    >
                      Edit Site &rarr;
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Multi-Domain Platform Health */}
        <section className="rounded-2xl border border-[#DFE4EB]/10 bg-[#0B0A16]/40 p-6 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h3 className="font-display text-base font-medium text-white">Active DakyXTech Domains</h3>
              <p className="text-xs text-[#69758A]">Live topology on the primary dakyx.com namespace</p>
            </div>
            <span className="text-[11px] font-mono text-[#B8FF3D] bg-[#B8FF3D]/10 px-2.5 py-1 rounded-full border border-[#B8FF3D]/30">
              Zero External Redirects • Native Architecture
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-2">
            <div className="p-3.5 rounded-xl bg-white/5 border border-white/5 space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono font-medium text-white">dakyx.com</span>
                <span className="w-2 h-2 rounded-full bg-[#B8FF3D]"></span>
              </div>
              <p className="text-[11px] text-[#69758A]">Corporate & Marketing Apex</p>
            </div>

            <div className="p-3.5 rounded-xl bg-white/5 border border-white/5 space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono font-medium text-white">app.dakyx.com</span>
                <span className="w-2 h-2 rounded-full bg-[#B8FF3D]"></span>
              </div>
              <p className="text-[11px] text-[#69758A]">Customer Control Center</p>
            </div>

            <div className="p-3.5 rounded-xl bg-white/5 border border-white/5 space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono font-medium text-white">editor.dakyx.com</span>
                <span className="w-2 h-2 rounded-full bg-[#B8FF3D]"></span>
              </div>
              <p className="text-[11px] text-[#69758A]">Standalone Website Editor</p>
            </div>

            <div className="p-3.5 rounded-xl bg-white/5 border border-white/5 space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono font-medium text-white">os.dakyx.com</span>
                <span className="w-2 h-2 rounded-full bg-[#B8FF3D]"></span>
              </div>
              <p className="text-[11px] text-[#69758A]">Company Operating System</p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default CustomerWorkspace;
