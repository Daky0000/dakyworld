import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { SiteSummary } from "../lib/types";
import { Button, PageHeader } from "./ui";
import { ConnectWebsite } from "./ConnectWebsite";

type Config = { connectionEditable?: boolean; name: string; publicUrl: string; repoOwner: string | null; repoName: string | null; repoBranch: string; repoPath: string; options: { colours: string[]; fonts: string[]; brandVoice: string; aiEnabled: boolean } };
type ManagedSite = SiteSummary & { capabilities?: { manage: boolean } };
const INPUT = "mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-blue focus:ring-2 focus:ring-blue/20 disabled:bg-cream";

export function WebsiteSettings() {
  const { can, user } = useAuth();
  const sites = useQuery({ queryKey: ["website", "sites"], queryFn: () => api.get<ManagedSite[]>("/website/sites") });
  const manageable = sites.data?.filter(site => site.capabilities?.manage !== false) ?? [];
  const [selected, setSelected] = useState("");
  const id = manageable.some(site => site.id === selected) ? selected : manageable[0]?.id;
  const config = useQuery({ queryKey: ["website", "config", id], enabled: !!id, queryFn: () => api.get<Config>(`/website/sites/${id}/config`) });
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
  const paletteError = colours.length > 16 ? "Use up to 16 colours." : colours.some(colour => !/^#[\da-f]{6}$/i.test(colour)) ? "Enter each colour as a six-digit hex code, such as #3157FF." : null;
  const fontsError = fonts.length > 12 ? "Use up to 12 font families." : fonts.some(font => font.length > 80 || !/^[a-zA-Z0-9 ,.-]+$/.test(font)) ? "Use font family names containing letters, numbers, spaces, commas, periods or hyphens." : null;

  return <div>
    <PageHeader title="Website settings" subtitle="Connect your source and use your own design system in the editor." action={!user?.external && can("website.manage") ? <ConnectWebsite /> : undefined} />
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
      if (!dirty || save.isPending || paletteError || fontsError) return;
      save.mutate({ ...draft, options: { ...draft.options, colours, fonts } });
    }}>
      <fieldset disabled={save.isPending} className="space-y-6">
        <section className="rounded-2xl border border-line bg-white p-5">
          <h2 className="mb-4 font-display text-lg">Source & publishing</h2>
          <div className="grid gap-4 sm:grid-cols-2">{([["name", "Name"], ["publicUrl", "Public address"], ["repoOwner", "Repository owner"], ["repoName", "Repository name"], ["repoBranch", "Branch"], ["repoPath", "HTML folder"]] as const).map(([key, label]) => <label key={key} className="text-xs text-muted">{label}<input className={INPUT} value={draft[key] ?? ""} disabled={key.startsWith("repo") && draft.connectionEditable === false} required={key === "name" || key === "publicUrl" || key === "repoBranch"} maxLength={key === "publicUrl" ? 2000 : key === "repoPath" ? 200 : key === "name" ? 120 : 100} type={key === "publicUrl" ? "url" : "text"} onChange={event => change(key, (key === "repoOwner" || key === "repoName") && !event.target.value ? null : event.target.value)} /></label>)}</div>
          <p className="mt-3 text-xs text-muted">Publishing writes to this branch. Your administrator connects the repository credentials. An imported page can also be downloaded as HTML.</p>
        </section>
        <section className="rounded-2xl border border-line bg-white p-5">
          <h2 className="mb-4 font-display text-lg">Design system</h2>
          <label className="block text-xs text-muted">Colour palette<input className={INPUT} placeholder="#3157FF, #08101F, #FFFFFF" value={colourText} aria-invalid={Boolean(paletteError)} onChange={event => { setColourText(event.target.value); changed(); }} /></label>
          <div className="my-3 flex flex-wrap gap-2">{colours.filter(colour => /^#[\da-f]{6}$/i.test(colour)).map((colour, index) => <span key={index} title={colour} className="h-7 w-7 rounded-xl border border-line" style={{ background: colour }} />)}</div>
          {paletteError && <p className="mb-3 text-xs text-danger-text">{paletteError}</p>}
          <label className="block text-xs text-muted">Fonts (one family per line)<textarea className={`${INPUT} h-24`} placeholder={"Space Grotesk\nDM Sans"} value={fontText} aria-invalid={Boolean(fontsError)} onChange={event => { setFontText(event.target.value); changed(); }} /></label>
          {fontsError && <p className="mt-2 text-xs text-danger-text">{fontsError}</p>}
          <p className="mt-2 text-xs text-muted">Font files must already be loaded by the website.</p>
        </section>
        <section className="rounded-2xl border border-line bg-white p-5">
          <h2 className="mb-3 font-display text-lg">AI suggestions</h2>
          <label className="flex items-start gap-3 text-sm text-ink"><input type="checkbox" className="mt-1 accent-blue" checked={draft.options.aiEnabled} onChange={event => changeOption("aiEnabled", event.target.checked)} /><span><span className="font-medium">Enable the design assistant</span><span className="mt-1 block text-xs leading-relaxed text-muted">Editors can request suggestions for selected content or the page. Every suggestion is reviewed before it is added to the draft, and publishing remains a separate action.</span></span></label>
          <label className="mt-5 block text-xs text-muted">Brand voice<textarea className={`${INPUT} min-h-28`} maxLength={4000} value={draft.options.brandVoice} onChange={event => changeOption("brandVoice", event.target.value)} placeholder="For example: direct, welcoming and specific. Use British spelling. Keep our product names as written." /></label>
          <p className="mt-2 text-xs text-muted">These notes guide suggestions for this website. AI requests use the configured model and the existing spending limits. Visual editing works with AI disabled.</p>
        </section>
        <div className="flex items-center gap-4"><Button type="submit" disabled={!dirty || save.isPending || Boolean(paletteError || fontsError)}>{save.isPending ? "Saving…" : "Save settings"}</Button>{save.isSuccess && !dirty && <span role="status" className="text-sm text-muted">Settings saved.</span>}{save.error && <span role="alert" className="text-sm text-danger-text">{(save.error as Error).message}</span>}</div>
      </fieldset>
    </form>}
  </div>;
}
