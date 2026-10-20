import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Button, Card, Notice } from "./ui";

/**
 * How this site goes live, and the one way to make it faster.
 *
 * The server works out the host from evidence (services/websiteDeployDetect.ts)
 * and picks the one faster route that fits (services/websiteDeployRoutes.ts,
 * `instantOffer`). This shows that answer in plain words, the warning that
 * matters most (a host deploying a different branch, so publishes never
 * appear), and the single card for the faster route. Every faster route is an
 * upgrade: a site works with none of them.
 */

type Evidence = { kind: string; host?: string; detail: string };
type Profile = {
  host: string;
  answer: "auto" | "needs-hook" | "branch-mismatch" | "unsure";
  evidence: Evidence[];
  deployBranch?: string;
  deployFolder?: string;
  hasBuildStep: boolean | null;
  typicalSeconds?: number;
  lastCheckedAt: string;
  missingAccess: string[];
  pages?: { buildType: "legacy" | "workflow" | null; noJekyll: boolean; jekyllContent: boolean };
  routes: { pages?: { workflowInstalled: boolean } };
  disabledRoutes: string[];
};
type BridgeDns = { txt: { name: string; value: string }; cname: { name: string; value: string }; apex: boolean; guidance: string | null; untouched: string };
type DeployView = {
  profile: Profile | null;
  hook: { configured: boolean; masked: string | null; provider: string | null; used: boolean };
  connections: Array<{ provider: string; name: string | null; matched: boolean; paused: boolean; pausedReason: string | null; lastUsedAt: string | null }>;
  providers: { netlify: boolean; vercel: boolean };
  pagesApp: { configured: boolean; installed: boolean };
  bridge: { hostname: string; origin: string; status: string; sslStatus: string | null; disabledReason: string | null; dns: BridgeDns | null } | null;
  bridgeConfigured: boolean;
  disabledGlobally: string[];
  offer: { kind: string | null; text: string | null; button: string | null; active: boolean };
};
type Candidate = { id: string; name: string; url: string | null; reason: string };

const HOST_NAME: Record<string, string> = {
  "github-pages": "GitHub Pages",
  vercel: "Vercel",
  netlify: "Netlify",
  "cloudflare-pages": "Cloudflare Pages",
  hostinger: "Hostinger",
  render: "Render",
  unknown: "a host we could not identify",
};
const PROVIDER: Record<string, string> = { netlify: "Netlify", vercel: "Vercel" };
const ROUTE_NAME: Record<string, string> = { bridge: "Edge bridge", direct: "Direct upload", pages: "Fast GitHub Pages", hook: "Deploy hook" };

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 rounded-lg bg-ink/[.03] px-3 py-2 font-mono text-xs">
      <span className="min-w-16 font-sans text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className="break-all text-ink">{value}</span>
    </div>
  );
}

function answerLine(profile: Profile): string {
  const host = HOST_NAME[profile.host] ?? profile.host;
  switch (profile.answer) {
    case "auto":
      return `${host} rebuilds this site on its own after every publish${profile.typicalSeconds ? `, usually in about ${profile.typicalSeconds} seconds` : ""}.`;
    case "needs-hook":
      return `${host} serves this site, but a publish does not reach it on its own. Add its deploy hook below and every publish will start a rebuild.`;
    case "branch-mismatch":
      return `${host} deploys ${profile.deployBranch ? `branch ${profile.deployBranch}` : "a different branch"}${profile.deployFolder && profile.deployFolder !== "/" ? `, folder ${profile.deployFolder}` : ""}, which is not where publishing writes. Publishes will not appear until the two match.`;
    default:
      return profile.host === "unknown"
        ? "We could not tell yet how this site goes live. We will learn from the next publish."
        : `${host} serves this site. We are not sure yet whether it rebuilds on its own; the next publish will tell us.`;
  }
}

/** Where the browser goes for a host's own approval screen. */
function go(url: string) {
  window.location.assign(url);
}

export function WebsiteDeployPanel({ siteId }: { siteId: string }) {
  const qc = useQueryClient();
  const key = ["website", "deploy", siteId];
  const [message, setMessage] = useState<{ tone: "info" | "warn" | "positive"; text: string } | null>(null);
  const [hookUrl, setHookUrl] = useState("");
  const [choose, setChoose] = useState<string | null>(null);
  const [dnsHelp, setDnsHelp] = useState<{ dns: BridgeDns; oneClick: string | null } | null>(null);
  const [steps, setSteps] = useState<Array<{ step: string; done: boolean; note?: string }> | null>(null);

  const deploy = useQuery({ queryKey: key, queryFn: ({ signal }) => api.get<DeployView>(`/website/sites/${siteId}/deploy`, signal) });
  const set = (view?: DeployView) => (view ? qc.setQueryData(key, view) : void qc.invalidateQueries({ queryKey: key }));
  const fail = (error: Error) => setMessage({ tone: "warn", text: error.message });

  // Coming back from a host's own screen.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("deployError");
    if (connected) setMessage({ tone: "positive", text: connected === "bridge" ? "Your DNS provider made the change. We are checking it now." : connected === "pages" ? "DakyX Pages is installed." : `${PROVIDER[connected] ?? connected} is connected.` });
    if (error) setMessage({ tone: "warn", text: error });
    if (params.get("choose")) setChoose(params.get("choose"));
    if (connected || error || params.get("choose")) {
      ["connected", "deployError", "choose"].forEach((name) => params.delete(name));
      window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
    }
  }, []);

  const detect = useMutation({ mutationFn: () => api.post<DeployView>(`/website/sites/${siteId}/deploy/detect`, {}), onSuccess: (view) => { set(view); setMessage(null); }, onError: fail });
  const saveHook = useMutation({
    mutationFn: (url: string | null) => api.put<{ masked: string | null }>(`/website/sites/${siteId}/deploy/hook`, { url, test: true }),
    onSuccess: (saved) => { setHookUrl(""); set(); setMessage({ tone: "positive", text: saved.masked ? "The host accepted the deploy hook. Every publish will now start a rebuild." : "Deploy hook removed." }); },
    onError: fail,
  });
  const noJekyll = useMutation({ mutationFn: () => api.post<DeployView>(`/website/sites/${siteId}/deploy/nojekyll`, {}), onSuccess: (view) => { set(view); setMessage({ tone: "positive", text: "Added .nojekyll. GitHub Pages will skip the Jekyll build from the next publish." }); }, onError: fail });
  const routeSwitch = useMutation({ mutationFn: (input: { route: string; enabled: boolean }) => api.put<DeployView>(`/website/sites/${siteId}/deploy/routes`, input), onSuccess: (view) => set(view), onError: fail });
  const connect = useMutation({ mutationFn: (provider: string) => api.post<{ url: string }>(`/website/sites/${siteId}/connect/${provider}`, {}), onSuccess: ({ url }) => go(url), onError: fail });
  const disconnect = useMutation({
    mutationFn: (provider: string) => api.delete<{ note: string | null; view: DeployView }>(`/website/sites/${siteId}/connect/${provider}`),
    onSuccess: (result) => { set(result.view); setMessage({ tone: "info", text: result.note ?? "Disconnected." }); },
    onError: fail,
  });
  const candidates = useQuery({
    queryKey: ["website", "deploy", siteId, "candidates", choose],
    enabled: Boolean(choose),
    queryFn: ({ signal }) => api.get<{ candidates: Candidate[] }>(`/website/sites/${siteId}/connect/${choose}/candidates`, signal),
  });
  const pick = useMutation({
    mutationFn: (externalSiteId: string) => api.put<{ view: DeployView }>(`/website/sites/${siteId}/connect/${choose}`, { externalSiteId }),
    onSuccess: (result) => { set(result.view); setChoose(null); setMessage({ tone: "positive", text: "Matched. Publishes go straight to your host from now on." }); },
    onError: fail,
  });
  const pages = useMutation({
    mutationFn: (enabled: boolean) => api.post<{ installUrl?: string; view?: DeployView }>(`/website/sites/${siteId}/deploy/pages`, { enabled }),
    onSuccess: (result) => (result.installUrl ? go(result.installUrl) : set(result.view)),
    onError: fail,
  });
  const startBridge = useMutation({
    mutationFn: () => api.post<{ dns: BridgeDns; oneClick: string | null; view: DeployView }>(`/website/sites/${siteId}/bridge`, {}),
    onSuccess: (result) => { set(result.view); setDnsHelp({ dns: result.dns, oneClick: result.oneClick }); },
    onError: fail,
  });
  const checkBridge = useMutation({
    mutationFn: () => api.post<{ status: string; steps: Array<{ step: string; done: boolean; note?: string }>; view: DeployView }>(`/website/sites/${siteId}/bridge/check`, {}),
    onSuccess: (result) => { set(result.view); setSteps(result.steps); },
    onError: fail,
  });
  const pauseBridge = useMutation({ mutationFn: (paused: boolean) => api.put<{ view: DeployView }>(`/website/sites/${siteId}/bridge`, { paused }), onSuccess: (result) => set(result.view), onError: fail });
  const removeBridge = useMutation({ mutationFn: () => api.delete<{ view: DeployView }>(`/website/sites/${siteId}/bridge`), onSuccess: (result) => { set(result.view); setDnsHelp(null); setSteps(null); }, onError: fail });

  if (deploy.isLoading) return <p className="text-sm text-muted">Loading how this site goes live…</p>;
  if (deploy.isError) return <Notice tone="warn">{(deploy.error as Error).message}</Notice>;
  const view = deploy.data!;
  const profile = view.profile;
  const offer = view.offer;
  const bridgeDns = dnsHelp?.dns ?? view.bridge?.dns ?? null;
  const showHook = view.hook.configured || profile?.answer === "needs-hook" || profile?.answer === "unsure";

  return (
    <Card className="space-y-5 p-6">
      <div data-section="deploy-how">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="font-display text-lg font-medium text-ink">How this site goes live</h2>
          <Button size="sm" variant="secondary" disabled={detect.isPending} onClick={() => detect.mutate()}>{detect.isPending ? "Looking…" : "Check again"}</Button>
        </div>
        {!profile ? (
          <p className="mt-2 text-sm text-muted">We have not looked at this site's host yet. Press Check again, or publish, and we will work it out.</p>
        ) : (
          <>
            {profile.answer === "branch-mismatch" ? (
              <Notice tone="warn" className="mt-3" title="Publishes will not appear yet">{answerLine(profile)} Change the branch in the repository settings above, or change what your host deploys.</Notice>
            ) : (
              <p className="mt-2 text-sm leading-relaxed text-muted">{answerLine(profile)}</p>
            )}
            {profile.missingAccess.length > 0 && (
              <p className="mt-2 text-xs text-muted">Approve the DakyX app's new read access on GitHub (GitHub asks the repository's owner) to see each publish's progress live: queued, building, live.</p>
            )}
            <details className="mt-3 text-xs text-muted">
              <summary className="cursor-pointer">What we found</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5">{profile.evidence.map((entry, index) => <li key={index}>{entry.detail}</li>)}</ul>
              <p className="mt-2">Checked {new Date(profile.lastCheckedAt).toLocaleString()}.</p>
            </details>
          </>
        )}
      </div>

      {profile?.host === "github-pages" && profile.pages?.buildType === "legacy" && !profile.pages.noJekyll && !profile.pages.jekyllContent && (
        <div className="border-t border-line pt-5" data-section="deploy-nojekyll">
          <h3 className="text-sm font-semibold text-ink">Skip the Jekyll build</h3>
          <p className="mt-1 text-sm text-muted">This site is plain HTML, so GitHub Pages' Jekyll step does nothing for it but take time. One empty file tells GitHub to skip it.</p>
          <Button size="sm" className="mt-3" disabled={noJekyll.isPending} onClick={() => noJekyll.mutate()}>{noJekyll.isPending ? "Adding…" : "Skip Jekyll"}</Button>
        </div>
      )}

      {showHook && (
        <div className="border-t border-line pt-5" data-section="deploy-hook">
          <h3 className="text-sm font-semibold text-ink">Deploy hook</h3>
          {view.hook.configured ? (
            <div className="mt-2 space-y-2">
              <Row label="Hook" value={view.hook.masked ?? ""} />
              {!view.hook.used && <p className="text-xs text-muted">Your host rebuilds on its own, so the hook is not called. It is kept in case that changes.</p>}
              <Button size="sm" variant="secondary" disabled={saveHook.isPending} onClick={() => saveHook.mutate(null)}>Remove hook</Button>
            </div>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted">Copy the deploy hook (sometimes called a build hook) from your host's settings and paste it here. We call it once now to check it works, then after every publish.</p>
              <div className="mt-3 flex flex-wrap gap-3">
                <input className="min-w-64 flex-1 rounded-xl border border-line bg-cream px-3 py-2 text-sm" placeholder="https://api.netlify.com/build_hooks/…" value={hookUrl} onChange={(event) => setHookUrl(event.target.value)} aria-label="Deploy hook address" />
                <Button size="sm" disabled={!hookUrl.trim() || saveHook.isPending} onClick={() => saveHook.mutate(hookUrl.trim())}>{saveHook.isPending ? "Testing…" : "Test and save"}</Button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="border-t border-line pt-5" data-section="deploy-instant">
        <h3 className="text-sm font-semibold text-ink">Make updates instant</h3>
        {offer.text ? <p className="mt-1 text-sm text-muted">{offer.text}</p> : <p className="mt-1 text-sm text-muted">Nothing faster fits this site yet. Publishing works as it is.</p>}
        {offer.button && (
          <Button
            size="sm"
            className="mt-3"
            disabled={connect.isPending || pages.isPending || startBridge.isPending}
            onClick={() => {
              if (offer.kind === "direct-netlify") connect.mutate("netlify");
              else if (offer.kind === "direct-vercel") connect.mutate("vercel");
              else if (offer.kind === "pages") pages.mutate(true);
              else if (offer.kind === "bridge") startBridge.mutate();
            }}
          >
            {offer.button}
          </Button>
        )}

        {view.connections.map((connection) => (
          <div key={connection.provider} className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium text-ink">{PROVIDER[connection.provider] ?? connection.provider}{connection.name ? ` · ${connection.name}` : ""}</span>
            {connection.paused ? <span className="rounded-full bg-warn-surface px-2.5 py-1 text-[11px] font-semibold text-warn-text">Instant updates paused</span> : !connection.matched ? <span className="rounded-full bg-warn-surface px-2.5 py-1 text-[11px] font-semibold text-warn-text">Choose which site</span> : <span className="rounded-full bg-ok-surface px-2.5 py-1 text-[11px] font-semibold text-ok-text">Connected</span>}
            {connection.paused && <Button size="sm" onClick={() => connect.mutate(connection.provider)}>Reconnect {PROVIDER[connection.provider]}</Button>}
            {!connection.matched && !connection.paused && <Button size="sm" variant="secondary" onClick={() => setChoose(connection.provider)}>Choose</Button>}
            <Button size="sm" variant="ghost" disabled={disconnect.isPending} onClick={() => disconnect.mutate(connection.provider)}>Disconnect</Button>
            {connection.paused && connection.pausedReason && <p className="w-full text-xs text-muted">{connection.pausedReason}</p>}
          </div>
        ))}

        {choose && (
          <div className="mt-3 rounded-xl border border-line p-3" data-section="deploy-choose">
            <p className="text-sm text-ink">Which {PROVIDER[choose] ?? choose} site is this?</p>
            {candidates.isLoading && <p className="mt-2 text-xs text-muted">Loading your sites…</p>}
            <ul className="mt-2 space-y-1">{candidates.data?.candidates.map((candidate) => (
              <li key={candidate.id}><button type="button" className="text-left text-sm text-blue hover:underline" onClick={() => pick.mutate(candidate.id)}>{candidate.name}</button> <span className="text-xs text-muted">{candidate.reason}</span></li>
            ))}</ul>
          </div>
        )}

        {view.bridge && (
          <div className="mt-4 space-y-2" data-section="deploy-bridge">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-sm text-ink">{view.bridge.hostname}</span>
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${view.bridge.status === "active" ? "bg-ok-surface text-ok-text" : "bg-warn-surface text-warn-text"}`}>
                {view.bridge.status === "active" ? "Instant" : view.bridge.status === "disabled" ? "Paused" : "Waiting for DNS"}
              </span>
            </div>
            {view.bridge.status === "pending-dns" && bridgeDns && (
              <>
                <p className="text-sm text-muted">Add these two records at whoever manages your domain, then press Check. The TXT record proves the domain is yours; the CNAME puts DakyX in front of your host.</p>
                {dnsHelp?.oneClick && <Button size="sm" onClick={() => go(dnsHelp.oneClick!)}>Make the change for me</Button>}
                <Row label="TXT" value={`${bridgeDns.txt.name} → ${bridgeDns.txt.value}`} />
                <Row label="CNAME" value={`${bridgeDns.cname.name} → ${bridgeDns.cname.value}`} />
                {bridgeDns.guidance && <Notice tone="info">{bridgeDns.guidance}</Notice>}
                <p className="text-xs text-muted">{bridgeDns.untouched}</p>
              </>
            )}
            {steps && <ul className="space-y-1 text-sm">{steps.map((entry) => <li key={entry.step} className={entry.done ? "text-ok-text" : "text-muted"}>{entry.done ? "✓" : "○"} {entry.step}{entry.note ? <span className="block pl-5 text-xs text-muted">{entry.note}</span> : null}</li>)}</ul>}
            <div className="flex flex-wrap gap-3">
              {view.bridge.status === "pending-dns" && <Button size="sm" disabled={checkBridge.isPending} onClick={() => checkBridge.mutate()}>{checkBridge.isPending ? "Checking…" : "Check"}</Button>}
              {view.bridge.status !== "pending-dns" && <Button size="sm" variant="secondary" disabled={pauseBridge.isPending} onClick={() => pauseBridge.mutate(view.bridge!.status !== "disabled")}>{view.bridge.status === "disabled" ? "Resume" : "Pause"}</Button>}
              <Button size="sm" variant="ghost" disabled={removeBridge.isPending} onClick={() => removeBridge.mutate()}>Remove</Button>
            </div>
          </div>
        )}

        {profile?.routes.pages?.workflowInstalled && (
          <div className="mt-3"><Button size="sm" variant="ghost" disabled={pages.isPending} onClick={() => pages.mutate(false)}>Go back to GitHub Pages' own build</Button></div>
        )}
      </div>

      {profile && (
        <details className="border-t border-line pt-5 text-sm" data-section="deploy-switches">
          <summary className="cursor-pointer text-sm font-semibold text-ink">Faster routes on this site</summary>
          <ul className="mt-3 space-y-2">
            {Object.entries(ROUTE_NAME).map(([route, name]) => {
              const offGlobally = view.disabledGlobally.includes(route);
              const on = !profile.disabledRoutes.includes(route);
              return (
                <li key={route} className="flex items-center gap-3">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" className="accent-blue" checked={on && !offGlobally} disabled={offGlobally || routeSwitch.isPending} onChange={(event) => routeSwitch.mutate({ route, enabled: event.target.checked })} />
                    {name}
                  </label>
                  {offGlobally && <span className="text-xs text-muted">Switched off for every site by DakyX</span>}
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-muted">Switching one off makes publishes follow your host's own deploy instead. Nothing else changes.</p>
        </details>
      )}

      {message && <Notice tone={message.tone === "positive" ? "positive" : message.tone}>{message.text}</Notice>}
    </Card>
  );
}
