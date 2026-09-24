import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { DraftSaveResult, FieldKind, SitePageDetail, SitePageRow } from "../lib/types";
import { matchesPreset, mergePreset, presetPagePlan, PRESET_PROPERTIES, type BrandPreset } from "../lib/websiteBrandPresets";
import { ColorCodeInput } from "./InspectorControls";

export function WebsitePresetPicker({ presets, kind, tag, style, onApply }: { presets: BrandPreset[]; kind: FieldKind; tag: string; style: string; onApply: (style: string) => void }) {
  const available = presets.filter(preset => matchesPreset(preset, { kind, tag }));
  return <div className="mb-3"><label className="block text-xs font-semibold">Brand style<select aria-label="Brand style" className="mt-1 w-full rounded-[10px] border border-line p-2 text-sm" value="" disabled={!available.length} onChange={e => { const preset = available.find(item => item.id === e.target.value); if (preset) onApply(mergePreset(style, preset)); }}><option value="">{available.length ? "Choose an approved style" : "No approved styles for this element"}</option>{available.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label></div>;
}

export function WebsitePresetSettings({ presets, onChange }: { presets: BrandPreset[]; onChange: (presets: BrandPreset[]) => void }) {
  const update = (id: string, patch: Partial<BrandPreset>) => onChange(presets.map(preset => preset.id === id ? { ...preset, ...patch } : preset));
  return <section className="rounded-2xl border border-line bg-white p-5"><h2 className="font-display text-lg">Reusable brand styles</h2><p className="my-2 text-sm text-muted">Define approved heading, button and spacing styles. Saving makes them available to editors. Applying them creates drafts for review.</p>
    {presets.map(preset => <div key={preset.id} className="my-4 space-y-3 rounded-xl border border-line p-3"><div className="flex flex-wrap gap-2"><input aria-label="Style name" required maxLength={60} className="min-w-0 basis-full rounded-[10px] border border-line p-2 sm:flex-1 sm:basis-auto" value={preset.name} onChange={e => update(preset.id, { name: e.target.value })} /><select aria-label="Style applies to" value={preset.target} onChange={e => update(preset.id, { target: e.target.value as BrandPreset["target"], styles: {} })}><option value="heading">Headings</option><option value="button">Buttons</option><option value="spacing">Containers</option></select><button type="button" onClick={() => onChange(presets.filter(item => item.id !== preset.id))} className="text-sm text-danger-text">Remove style</button></div>
      <div className="grid gap-3 sm:grid-cols-2">{PRESET_PROPERTIES.filter(property => preset.target === "spacing" ? ["padding", "margin", "gap"].includes(property) : preset.target === "heading" ? ["font-family", "font-size", "font-weight", "line-height", "color"].includes(property) : !["margin", "gap"].includes(property)).map(property => <label key={property} className="text-xs capitalize">{property.replaceAll("-", " ")}{property.includes("color") ? <div className="mt-1"><ColorCodeInput ariaLabel={`${preset.name} ${property}`} placeholder="#3157FF" value={preset.styles[property] ?? ""} onChange={val => { const styles = { ...preset.styles }; if (val) styles[property] = val; else delete styles[property]; update(preset.id, { styles }); }} /></div> : <input aria-label={`${preset.name} ${property}`} className="mt-1 block w-full rounded-[10px] border border-line p-2 text-sm" maxLength={100} placeholder={property === "font-family" ? "Existing website font" : property === "font-weight" ? "For example 600" : property === "line-height" ? "For example 1.4" : "For example 16px"} value={preset.styles[property] ?? ""} onChange={e => { const styles = { ...preset.styles }; if (e.target.value) styles[property] = e.target.value; else delete styles[property]; update(preset.id, { styles }); }} />}</label>)}</div>
    </div>)}
    <button type="button" disabled={presets.length >= 20} className="rounded-xl border border-line px-3 py-2 text-sm disabled:opacity-50" onClick={() => onChange([...presets, { id: crypto.randomUUID(), name: "New brand style", target: "heading", styles: {} }])}>Add brand style</button>
  </section>;
}

type Plan = { page: SitePageDetail; plan: ReturnType<typeof presetPagePlan>; state?: string };
export function WebsitePresetRollout({ siteId, presets, disabled }: { siteId: string; presets: BrandPreset[]; disabled: boolean }) {
  const [selected, setSelected] = useState("");
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState(false);
  const preset = presets.find(item => item.id === selected);
  async function review() {
    if (!preset) return;
    setBusy(true); setError(""); setPlans(null); setApplied(false);
    try {
      const list = await api.get<{ pages: SitePageRow[] }>(`/website/sites/${siteId}/pages`);
      const next: Plan[] = [];
      for (const row of list.pages) { const page = await api.get<SitePageDetail>(`/website/pages/${row.id}`); if (page.structure?.stale || page.problems.length) throw new Error(`Resolve the existing draft problems on ${row.title} before applying a brand style.`); next.push({ page, plan: presetPagePlan(page, preset) }); }
      setPlans(next);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function apply() {
    if (!plans) return;
    setBusy(true); setError("");
    const results = [...plans];
    for (let i = 0; i < results.length; i++) {
      const item = results[i];
      if (!item.plan.changes.length) continue;
      try {
        const result = await api.put<DraftSaveResult>(`/website/pages/${item.page.page.id}/draft`, { ifRevision: item.page.draft.revision, documentHash: item.page.draft.documentHash ?? null, sharedRevisions: Object.fromEntries((item.page.shared?.elements ?? []).map(element => [element.id, element.revision])), values: item.plan.values });
        results[i] = { ...item, state: result.problems.length || result.unknown.length ? "Saved with issues: open this page to review." : "Draft saved. Review and publish this page." };
      } catch (e) { results[i] = { ...item, state: `Not applied: ${(e as Error).message}` }; }
      setPlans([...results]);
    }
    setBusy(false); setApplied(true);
  }
  return <section className="mt-6 max-w-3xl rounded-2xl border border-line bg-white p-5"><h2 className="font-display text-lg">Apply a brand style across pages</h2><p className="my-2 text-sm text-muted">Review matching elements first. Pages save individually with conflict protection. Linked shared elements are edited once in the editor and published through their shared review. Smaller-screen overrides remain in place.</p>
    <fieldset disabled={disabled || busy} className="space-y-3"><select aria-label="Brand style to apply across pages" value={selected} onChange={e => { setSelected(e.target.value); setPlans(null); setApplied(false); }} className="w-full rounded-xl border border-line p-2"><option value="">Choose a saved brand style</option>{presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button type="button" disabled={!preset || !Object.keys(preset.styles).length} onClick={() => void review()} className="rounded-xl border border-line px-3 py-2 text-sm disabled:opacity-50">Review affected pages</button>
    {plans && <><div className="space-y-3">{plans.map(item => <article key={item.page.page.id} className="rounded-xl bg-sunken p-3 text-sm"><Link className="font-semibold text-blue" to={`/website/pages/${item.page.page.id}`}>{item.page.page.title}</Link><p>{item.plan.changes.length} elements to update{item.plan.shared ? ` · ${item.plan.shared} linked elements use shared editing` : ""}</p><details><summary className="cursor-pointer">Show changes</summary>{item.plan.changes.map(change => <div className="my-2 break-words text-xs" key={change.id}><strong>{change.label}</strong><p>Before: {change.before || "Website stylesheet"}</p><p>After: {change.after}</p></div>)}</details>{item.state && <p role="status" className="mt-2">{item.state}</p>}</article>)}</div><button type="button" disabled={applied || !plans.some(item => item.plan.changes.length)} className="rounded-xl bg-ink px-3 py-2 text-sm text-white disabled:opacity-50" onClick={() => void apply()}>Apply reviewed changes to drafts</button></>}
    </fieldset>{busy && <p role="status" className="mt-3 text-sm">Working through the pages…</p>}{disabled && <p className="mt-3 text-sm text-muted">Save or resolve your settings changes first.</p>}{error && <p role="alert" className="mt-3 text-sm text-danger-text">{error}</p>}
  </section>;
}
