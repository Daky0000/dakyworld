import { useSiteDirectory, SiteDirectoryMore } from "../lib/siteDirectory";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { currentSurface } from "../lib/surface";
import { useAuth } from "../lib/auth";
import type { SiteSummary } from "../lib/types";
import { Button, PageHeader } from "./ui";
import { WebsitePresetSettings, WebsitePresetRollout } from "./WebsiteBrandPresets";
import type { BrandPreset } from "../lib/websiteBrandPresets";
import { ConnectWebsite } from "./ConnectWebsite";
import { WebsiteHostingPanel } from "./WebsiteHostingPanel";
import { WebsiteDeployPanel } from "./WebsiteDeployPanel";
import { WebsiteSubscriptionPanel } from "./WebsiteSubscriptionPanel";
import { ConnectGithubApp } from "./ConnectGithubApp";
import { ColorCodeInput } from "./InspectorControls";
import { WebsiteWordPressPanel } from "./ConnectWordPress";

type Config = { id?: string; clientId?: string | null; github?: { installationId: string | null; repositoryId: string | null; accessLostAt: string | null }; connectionEditable?: boolean; name: string; publicUrl: string; repoOwner: string | null; repoName: string | null; repoBranch: string; repoPath: string; options: { presets: BrandPreset[]; colours: string[]; fonts: string[]; brandVoice: string } };
type ManagedSite = SiteSummary & { capabilities?: { manage: boolean } };
const INPUT = "mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-blue focus:ring-2 focus:ring-blue/20 disabled:bg-cream";

export function WebsiteSettings() {
  const { can, user } = useAuth();
  const sites = useSiteDirectory<ManagedSite>();
  const manageable = sites.data?.filter(site => site.capabilities?.manage !== false) ?? [];
  // A host sends the browser back here with the site it was connecting.
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get("site") ?? "");
  const id = manageable.some(site => site.id === selected) ? selected : manageable[0]?.id;
  // A WordPress site has no repository and is not hosted here: its pages stay
  // in WordPress, so those settings are replaced by the WordPress connection.
  const wordpress = manageable.find(site => site.id === id)?.sourceKind === "wordpress";
  const config = useQuery({ queryKey: ["website", "config", id], enabled: !!id, queryFn: ({ signal }) => api.get<Config>(`/website/sites/${id}/config`, signal) });
  // Whose website this is. It is what decides whether a retainer covers the
  // Website Builder for them, so a site with no client can only be told that
  // nothing decides — see the "Who pays for this" line on Onboarding.
  // Staff only, and only in the OS: the client list is internal, a customer has
  // no business choosing "whose website" theirs is, and editor.dakyx.com
  // refuses /api/clients outright — the picker used to load nothing there.
  const pickClient = currentSurface() === "os" && !user?.external && can("clients.view");
  const clients = useQuery({ queryKey: ["clients", "for-sites"], enabled: pickClient, queryFn: ({ signal }) => api.get<Array<{ id: string; name: string }>>("/clients", signal) });
  const [draft, setDraft] = useState<Config | null>(null);
  const [dirty, setDirty] = useState(false);
  const [colourText, setColourText] = useState("");
  const [fontText, setFontText] = useState("");
  const qc = useQueryClient();
  useEffect(() => {
    if (config.data && !dirty) {
      setDraft(config.data);
      setColourText(config.data.options.colours.join(", "));
      setFontText(config.data.options.fonts.join("\n"));
    }
  }, [config.data, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  const save = useMutation({
    mutationFn: (payload: Config) => api.put(`/website/sites/${id}/config`, payload),
    onSuccess: async (_result, payload) => {
      qc.setQueryData(["website", "config", id], payload);
      setDraft(payload);
      setDirty(false);
      await qc.invalidateQueries({ queryKey: ["website"] });
    },
  });
  const changed = () => { setDirty(true); save.reset(); };
  const change = (key: keyof Config, value: unknown) => { setDraft(old => old ? { ...old, [key]: value } : old); changed(); };
  const changeOption = <K extends keyof Config["options"]>(key: K, value: Config["options"][K]) => {
    setDraft(old => old ? { ...old, options: { ...old.options, [key]: value } } : old);
    changed();
  };
  const colours = colourText.split(/[,\s]+/).filter(Boolean);
  const fonts = fontText.split("\n").map(font => font.trim()).filter(Boolean);
  const paletteError = colours.length > 16 ? "Use up to 16 colours." : colours.some(colour => !/^#[\da-f]{6}$/i.test(colour)) ? "Enter each colour as a six-digit hex code, such as #2563EB." : null;
  const presetError = draft?.options.presets?.some(preset => Object.entries(preset.styles).some(([property, value]) => !CSS.supports(property, value))) ? "One of the brand styles has an invalid colour, font or size. Correct it before saving." : null;
  const fontsError = fonts.length > 12 ? "Use up to 12 font families." : fonts.some(font => font.length > 80 || !/^[a-zA-Z0-9 ,.-]+$/.test(font)) ? "Use font family names containing letters, numbers, spaces, commas, periods or hyphens." : null;

  return <div>
    <PageHeader title="Website settings" subtitle="Connect your source and use your own design system in the editor." action={can("website.manage") ? <ConnectWebsite /> : undefined} />
    <SiteDirectoryMore directory={sites} />
    {sites.error && <p role="alert" className="text-danger-text">{(sites.error as Error).message}</p>}
    {sites.isLoading && <p className="text-sm text-muted">Loading websites…</p>}
    {sites.isSuccess && !manageable.length && <p className="text-sm text-muted">You do not manage any websites yet. A website manager can give you access to these settings.</p>}
    {!!manageable.length && <label className="mb-6 block max-w-md text-xs text-muted">Website<select className={INPUT} value={id} disabled={save.isPending} onChange={event => {
      if (dirty && !window.confirm("Discard the unsaved settings?")) return;
      setSelected(event.target.value); setDraft(null); setDirty(false); save.reset();
    }}>{manageable.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>}
    {config.isLoading && <p className="text-sm text-muted">Loading settings…</p>}
    {config.error && <p role="alert" className="text-danger-text">{(config.error as Error).message}</p>}
    {id && draft && !config.error && <form className="max-w-3xl" onSubmit={event => {
      event.preventDefault();
      if (!dirty || save.isPending || paletteError || fontsError || presetError) return;
      save.mutate({ ...draft, options: { ...draft.options, colours, fonts } });
    }}>
      <fieldset disabled={save.isPending} className="space-y-6">
        <section className="rounded-2xl border border-line bg-white p-5">
          <h2 className="mb-4 font-display text-lg">Source & publishing</h2>
          {pickClient && <label className="mb-4 block text-xs text-muted">Client<select className={INPUT} value={draft.clientId ?? ""} onChange={event => change("clientId" as keyof Config, (event.target.value || null) as never)}><option value="">DakyXTech&#39;s own website</option>{(Array.isArray(clients.data) ? clients.data : []).map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select><span className="mt-1 block text-[11px] text-faint">Whose website this is. A client on an active retainer gets the Website Builder at no charge; without a client here, nothing can work that out.</span></label>}
          <div className="grid gap-4 sm:grid-cols-2">{(wordpress ? ([["name", "Name"], ["publicUrl", "Public address"]] as const) : ([["name", "Name"], ["publicUrl", "Public address"], ["repoOwner", "Repository owner"], ["repoName", "Repository name"], ["repoBranch", "Branch"], ["repoPath", "HTML folder"]] as const)).map(([key, label]) => <label key={key} className="text-xs text-muted">{label}<input className={INPUT} value={draft[key] ?? ""} disabled={key.startsWith("repo") && draft.connectionEditable === false} required={key === "name" || key === "publicUrl" || key === "repoBranch"} maxLength={key === "publicUrl" ? 2000 : key === "repoPath" ? 200 : key === "name" ? 120 : 100} type={key === "publicUrl" ? "url" : "text"} onChange={event => change(key, (key === "repoOwner" || key === "repoName") && !event.target.value ? null : event.target.value)} /></label>)}</div>
          <p className="mt-3 text-xs text-muted">{wordpress ? "This is a WordPress website: publishing writes into its pages in WordPress, through the connection below." : "Publishing writes to this branch. Your administrator connects the repository credentials. An imported page can also be downloaded as HTML."}</p>
        </section>
        <section className="rounded-2xl border border-line bg-white p-5">
          <h2 className="mb-4 font-display text-lg">Design system</h2>
          <label className="block text-xs text-muted">Colour palette<input className={INPUT} placeholder="#2563EB, #08101F, #FFFFFF" value={colourText} aria-invalid={Boolean(paletteError)} onChange={event => { setColourText(event.target.value); changed(); }} /></label>
          <div className="my-3 flex flex-wrap items-center gap-2">
            {colours.map((colour, index) => (
              <div key={index} className="flex items-center gap-1">
                <ColorCodeInput
                  value={colour}
                  ariaLabel={`Palette colour ${index + 1}`}
                  onChange={next => {
                    const nextColours = [...colours];
                    if (next) nextColours[index] = next;
                    else nextColours.splice(index, 1);
                    setColourText(nextColours.join(", "));
                    changed();
                  }}
                />
              </div>
            ))}
            {colours.length < 16 && (
              <button
                type="button"
                className="h-8 rounded-lg border border-dashed border-line px-2.5 text-xs text-muted hover:border-ink hover:text-ink"
                onClick={() => {
                  const nextColours = [...colours, "#2563EB"];
                  setColourText(nextColours.join(", "));
                  changed();
                }}
              >
                + Add colour
              </button>
            )}
            <button
              type="button"
              className="h-8 rounded-lg border border-line bg-surface-2 px-2.5 text-xs text-ink transition hover:bg-surface-3"
              title="Automatically scan pages for declared HTML/CSS colours"
              onClick={async () => {
                try {
                  const res = await api.get<{ options: { colours: string[] } }>(`/website/sites/${id}/design`);
                  if (res.options.colours && res.options.colours.length) {
                    const merged = Array.from(new Set([...colours, ...res.options.colours])).slice(0, 16);
                    setColourText(merged.join(", "));
                    changed();
                  }
                } catch {}
              }}
            >
              Scan page colours
            </button>
          </div>
          {paletteError && <p className="mb-3 text-xs text-danger-text">{paletteError}</p>}
          <label className="block text-xs text-muted">Fonts (one family per line)<textarea className={`${INPUT} h-24`} placeholder={"Space Grotesk\nDM Sans"} value={fontText} aria-invalid={Boolean(fontsError)} onChange={event => { setFontText(event.target.value); changed(); }} /></label>
          {fontsError && <p className="mt-2 text-xs text-danger-text">{fontsError}</p>}
          <p className="mt-2 text-xs text-muted">Font files must already be loaded by the website.</p>
        </section>
        {presetError && <p role="alert" className="text-sm text-danger-text">{presetError}</p>}
        <WebsitePresetSettings presets={draft.options.presets ?? []} onChange={presets => changeOption("presets", presets)} />
        <section className="rounded-2xl border border-line bg-white p-5">
          <h2 className="mb-3 font-display text-lg">AI on this website</h2>
          <p className="text-sm leading-relaxed text-muted">The Builder agent and the design assistant are on for every website and cannot be switched off; the site's plan decides which of them it includes. Every change they make lands in the draft, and publishing stays a separate step.</p>
          <label className="mt-5 block text-xs text-muted">Brand voice<textarea className={`${INPUT} min-h-28`} maxLength={4000} value={draft.options.brandVoice} onChange={event => changeOption("brandVoice", event.target.value)} placeholder="For example: direct, welcoming and specific. Use British spelling. Keep our product names as written." /></label>
          <p className="mt-2 text-xs text-muted">These notes guide suggestions for this website. AI requests use the configured model and the existing spending limits. Visual editing works with AI disabled.</p>
        </section>
        <div className="flex items-center gap-4"><Button type="submit" disabled={!dirty || save.isPending || Boolean(paletteError || fontsError || presetError)}>{save.isPending ? "Saving…" : "Save settings"}</Button>{save.isSuccess && !dirty && <span role="status" className="text-sm text-muted">Settings saved.</span>}{save.error && <span role="alert" className="text-sm text-danger-text">{(save.error as Error).message}</span>}</div>
      </fieldset>
    </form>}
    {/* Where the website is served, and what the customer is paying. Both are
        questions people ask about their own site rather than about its design,
        so they sit above the design system rather than being filed under it. */}
    {id && <div className="mb-8 grid max-w-3xl gap-6">
      {wordpress && <WebsiteWordPressPanel key={id} siteId={id} />}
      {config.data?.repoName && <WebsiteDeployPanel key={id} siteId={id} />}
      {!wordpress && <WebsiteHostingPanel siteId={id} />}
      <WebsiteSubscriptionPanel />
    </div>}
    {id && config.data && <WebsitePresetRollout key={`${id}:${config.data.options.presets?.map(p => JSON.stringify(p)).join("")}`} siteId={id} presets={config.data.options.presets ?? []} disabled={dirty || save.isPending} />}
    {/* Beside the repository fields rather than inside the form: this is not a
        value somebody types and saves, it is a connection the customer makes. */}
    {config.data && id && !wordpress && <ConnectGithubApp
      siteId={id}
      installationId={config.data.github?.installationId ?? null}
      repoFullName={config.data.repoOwner && config.data.repoName ? `${config.data.repoOwner}/${config.data.repoName}` : null}
      accessLostAt={config.data.github?.accessLostAt ?? null}
      disabled={config.data.connectionEditable === false}
    />}
  </div>;
}
