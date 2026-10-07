import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import { setPageTitle } from "../lib/surface";
import type { SiteSummary as SiteRow } from "../lib/types";
import { planPriceSentence, useWebsiteTierStatus } from "../components/WebsiteTierStatusBanner";

/**
 * app.dakyx.com — a customer's account: what they have, where it lives, what
 * it costs.
 *
 * The first version of this screen was mostly invented. Every site card read
 * "undefined.dakyx.com" (the API never sent a subdomain) under a "LIVE" badge
 * that was typed in, an "Active Entitlement" that was typed in, two products
 * that do not exist on hostnames that do not resolve, engineering vocabulary
 * ("Redis Lease", "Canonical identity") and a panel showing customers the
 * company's internal hosts. Everything here is now read from the API, and
 * nothing is offered that cannot be opened.
 */

/** Where the editor lives from here. In local development it is the same origin. */
function editorOrigin(): string {
  const host = window.location.hostname;
  return host === "app.dakyx.com" ? "https://editor.dakyx.com" : "";
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

function siteAddress(site: SiteRow): string | null {
  if (site.customDomain) return `https://${site.customDomain}`;
  if (site.hosted) return site.hostedUrl ?? null;
  return site.publicUrl || null;
}

export function CustomerWorkspace() {
  const { user, logout } = useAuth();
  const sites = useQuery({
    queryKey: ["website", "sites"],
    queryFn: ({ signal }) => api.get<SiteRow[]>("/website/sites", signal),
  });
  const { status: plan } = useWebsiteTierStatus();
  useEffect(() => setPageTitle("Your account"), []);

  const editor = editorOrigin();
  const firstName = user?.name?.split(" ")[0] ?? "";

  return (
    <div className="min-h-screen bg-cream text-ink">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
          <img src="/brand/lockup-on-light.png" alt="DakyX" className="h-7 w-auto" />
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-muted sm:inline">{user?.email}</span>
            <button type="button" onClick={() => void logout()} className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:border-line-strong">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-10 px-4 py-10 sm:px-6">
        <section>
          <h1 className="font-display text-3xl font-medium tracking-[-.03em]">{firstName ? `Welcome back, ${firstName}.` : "Welcome back."}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">Your websites, your plan and your invoices, in one place.</p>
        </section>

        <section aria-labelledby="websites-heading">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="websites-heading" className="font-display text-xl font-medium">Your websites</h2>
            <a href={`${editor}/website/sites`} className="text-sm font-semibold text-blue hover:underline">Open the Website Editor</a>
          </div>
          {sites.isLoading && <p className="mt-4 text-sm text-muted">Loading…</p>}
          {sites.isError && <p role="alert" className="mt-4 text-sm text-warn-text">Your websites could not be loaded. Refresh to try again.</p>}
          {sites.data && sites.data.length === 0 && (
            <div className="mt-4 rounded-2xl border border-line bg-white p-6">
              <p className="text-sm text-ink">You have not added a website yet.</p>
              <p className="mt-1 text-sm text-muted">Bring your existing site in from its address or a file, or start from a template — it takes a few minutes.</p>
              <a href={`${editor}/website/welcome`} className="mt-4 inline-flex rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink/85">Add your website</a>
            </div>
          )}
          <ul className="mt-4 grid gap-4 sm:grid-cols-2">
            {sites.data?.map((site) => {
              const address = siteAddress(site);
              const live = Boolean(site.lastPublishedAt) && Boolean(address);
              return (
                <li key={site.id} className="rounded-2xl border border-line bg-white p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold">{site.name}</h3>
                      {address ? (
                        <a href={address} target="_blank" rel="noreferrer" className="block truncate text-xs text-blue hover:underline">{address.replace(/^https?:\/\//, "")}</a>
                      ) : (
                        <p className="text-xs text-muted">No public address yet</p>
                      )}
                    </div>
                    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${live ? "bg-positive-surface text-positive-text" : "bg-sunken text-muted"}`}>
                      {live ? "Live" : "Not published yet"}
                    </span>
                  </div>
                  <p className="mt-3 text-xs text-muted">
                    {site.pageCount} page{site.pageCount === 1 ? "" : "s"}
                    {site.draftCount > 0 ? ` · ${site.draftCount} with unpublished changes` : ""}
                    {site.lastPublishedAt ? ` · last published ${dateFormat.format(new Date(site.lastPublishedAt))}` : ""}
                  </p>
                  <a
                    href={site.firstPageId ? `${editor}/website/pages/${site.firstPageId}` : `${editor}/website/sites`}
                    className="mt-4 inline-flex rounded-full bg-ink px-4 py-2 text-xs font-semibold text-white hover:bg-ink/85"
                  >
                    Edit this website
                  </a>
                </li>
              );
            })}
          </ul>
        </section>

        {plan && (
          <section aria-labelledby="plan-heading" className="rounded-2xl border border-line bg-white p-5">
            <h2 id="plan-heading" className="font-display text-xl font-medium">Your plan</h2>
            <p className="mt-1 text-sm text-ink">{plan.tierName} — {planPriceSentence(plan.pricing)}</p>
            <ul className="mt-3 grid gap-1 text-sm text-muted sm:grid-cols-2">
              {plan.featureSummary.slice(0, 6).map((feature) => <li key={feature}>· {feature}</li>)}
            </ul>
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
              <a href={`${editor}/website/balance`} className="text-sm font-semibold text-blue hover:underline">Invoices, payments and upgrades</a>
              <a href={`${editor}/website/account`} className="text-sm font-semibold text-blue hover:underline">Password, sign-in and your data</a>
            </div>
          </section>
        )}

        <section aria-labelledby="help-heading" className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-line bg-white p-5">
            <h2 id="help-heading" className="font-semibold">Need a hand?</h2>
            <p className="mt-1 text-sm text-muted">The setup guide walks through adding your site, your first edit and connecting your own domain.</p>
            <a href="https://dakyx.com/website-builder-setup" className="mt-3 inline-block text-sm font-semibold text-blue hover:underline">Read the setup guide</a>
          </div>
          <div className="rounded-2xl border border-line bg-white p-5">
            <h2 className="font-semibold">More from DakyX</h2>
            <p className="mt-1 text-sm text-muted">We also build automations, integrations and practical AI for growing businesses.</p>
            <a href="https://dakyx.com/services" className="mt-3 inline-block text-sm font-semibold text-blue hover:underline">See what else we do</a>
          </div>
        </section>
      </main>
    </div>
  );
}
