import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { LeadGroup, MappingPreview, ScraperSource } from "../lib/types";
import { Badge, Button, Drawer, Field, Toggle } from "./ui";

const PRESETS = [
  { value: "AUTO", label: "Detect automatically", hint: "Reads the rows and picks the right reader. Start here." },
  { value: "GOOGLE_MAPS", label: "Google Maps place", hint: "title / categoryName / totalScore / placeId" },
  { value: "GENERIC_CONTACT", label: "Generic contact row", hint: "name / email / phone / url" },
  { value: "CUSTOM", label: "Custom field map only", hint: "Nothing is guessed — the field map below decides everything." },
];

const LEAD_SOURCES = ["GOOGLE_MAPS", "WEB_SCRAPE", "DIRECTORY", "SOCIAL", "LINKEDIN", "OUTREACH", "OTHER"];

/** The full zone list where the browser offers it; a sensible shortlist otherwise. */
function timezones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (typeof supported === "function") {
    try {
      return supported("timeZone");
    } catch {
      /* fall through */
    }
  }
  return ["Africa/Accra", "Africa/Lagos", "Africa/Nairobi", "Africa/Johannesburg", "Europe/London", "America/New_York", "UTC"];
}

export type SourceDraft = Omit<ScraperSource, "id" | "createdAt" | "_count" | "runs" | "lastRunAt" | "nextRunAt"> & {
  id?: string;
};

export const BLANK_SOURCE: SourceDraft = {
  name: "",
  actorId: "",
  description: "",
  input: {},
  fieldMap: null,
  preset: "AUTO",
  leadSource: "GOOGLE_MAPS",
  // No date in it. A dated name means a source can only ever *open* a list,
  // never add to one — which is what it did for months.
  groupName: "{{name}}",
  leadGroupId: null,
  enabled: true,
  maxItems: 100,
  minScore: 30,
  autoQualify: true,
  qualifyScore: 60,
  scheduleEnabled: false,
  scheduleTimes: [],
  timezone: "Africa/Accra",
};

/**
 * Add or edit one Apify actor as a lead source. Everything Apify needs — actor,
 * input JSON, run size — sits next to everything the pipeline needs — which
 * source label, which batch, what counts as qualified — because getting a
 * useful lead out of a scrape depends on both halves agreeing.
 */
export function SourceEditor({ draft, onClose }: { draft: SourceDraft | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<SourceDraft>(draft ?? BLANK_SOURCE);
  // Every list, so a source can be pointed at one somebody already works —
  // two sources feeding one audience is the normal case, not an edge one.
  const { data: groups } = useQuery({
    queryKey: ["lead-groups"],
    queryFn: () => api.get<LeadGroup[]>("/leads/groups"),
  });
  const [inputText, setInputText] = useState("{}");
  const [fieldMapText, setFieldMapText] = useState("");
  const [preview, setPreview] = useState<MappingPreview | null>(null);

  useEffect(() => {
    if (!draft) return;
    setForm(draft);
    setInputText(JSON.stringify(draft.input ?? {}, null, 2));
    setFieldMapText(draft.fieldMap ? JSON.stringify(draft.fieldMap, null, 2) : "");
    setPreview(null);
  }, [draft]);

  const inputError = useMemo(() => jsonError(inputText, "object"), [inputText]);
  const fieldMapError = useMemo(() => (fieldMapText.trim() ? jsonError(fieldMapText, "object") : null), [fieldMapText]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...form,
        description: form.description || null,
        groupName: form.groupName || null,
        leadGroupId: form.leadGroupId || null,
        input: JSON.parse(inputText),
        fieldMap: fieldMapText.trim() ? JSON.parse(fieldMapText) : null,
      };
      return form.id
        ? api.patch<ScraperSource>(`/scrapers/sources/${form.id}`, body)
        : api.post<ScraperSource>("/scrapers/sources", body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["scraper-sources"] });
      void qc.invalidateQueries({ queryKey: ["scraper-overview"] });
      onClose();
    },
  });

  const runPreview = useMutation({
    mutationFn: () => api.post<MappingPreview>(`/scrapers/sources/${form.id}/preview`, {}),
    onSuccess: setPreview,
  });

  const addTime = (time: string) => {
    if (!time || form.scheduleTimes.includes(time)) return;
    setForm({ ...form, scheduleTimes: [...form.scheduleTimes, time].sort(), scheduleEnabled: true });
  };

  return (
    <Drawer
      open={Boolean(draft)}
      onClose={onClose}
      wide
      title={form.id ? form.name || "Edit source" : "New lead source"}
      subtitle={form.actorId || "Point this at an Apify actor"}
      footer={
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => save.mutate()} disabled={save.isPending || Boolean(inputError || fieldMapError) || !form.name || !form.actorId}>
            {save.isPending ? "Saving…" : form.id ? "Save changes" : "Add source"}
          </Button>
          {form.id && (
            <Button variant="secondary" onClick={() => runPreview.mutate()} disabled={runPreview.isPending}>
              {runPreview.isPending ? "Reading…" : "Preview mapping"}
            </Button>
          )}
          {save.isError && <span className="text-xs text-danger-text">{(save.error as Error).message}</span>}
          {runPreview.isError && <span className="text-xs text-danger-text">{(runPreview.error as Error).message}</span>}
        </div>
      }
    >
      <div className="space-y-8">
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className="input" />
          </Field>
          <Field label="Apify actor" hint="e.g. compass/crawler-google-places">
            <input
              value={form.actorId}
              onChange={(event) => setForm({ ...form, actorId: event.target.value })}
              className="input font-mono text-xs"
            />
          </Field>
          <Field label="What this captures" full>
            <input
              value={form.description ?? ""}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="Dental clinics in Accra with no website"
              className="input"
            />
          </Field>
        </fieldset>

        <section>
          <SectionTitle>Actor input</SectionTitle>
          <p className="mb-2 text-xs text-muted">
            Passed to Apify exactly as written, except for the tokens replaced when the run starts:{" "}
            <code className="font-mono">{"{{date}}"}</code>, <code className="font-mono">{"{{yesterday}}"}</code> so a daily
            schedule can move its own search window, and <code className="font-mono">{"{{location}}"}</code>,{" "}
            <code className="font-mono">{"{{country}}"}</code>, <code className="font-mono">{"{{language}}"}</code> from
            Settings → Lead capture so the market is set in one place.
          </p>
          <p className="mb-2 text-xs text-muted">
            A proxy is added automatically for actors that take one; write the key yourself to override it.
          </p>
          <textarea
            rows={12}
            spellCheck={false}
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            className="code-input"
          />
          {inputError && <p className="mt-1 text-xs text-danger-text">{inputError}</p>}
        </section>

        <section>
          <SectionTitle>Reading the results</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Row shape">
              <select
                value={form.preset}
                onChange={(event) => setForm({ ...form, preset: event.target.value as ScraperSource["preset"] })}
                className="input"
              >
                {PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-muted">
                {PRESETS.find((preset) => preset.value === form.preset)?.hint}
              </span>
            </Field>
            <Field label="Label leads as">
              <select
                value={form.leadSource}
                onChange={(event) => setForm({ ...form, leadSource: event.target.value })}
                className="input"
              >
                {LEAD_SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {source.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Add leads to"
              hint={
                form.leadGroupId
                  ? "Every run adds to this list. Set it back to “by name” to let the name below decide again."
                  : "The first run adopts a list with this name, or opens one, and every run after adds to it. {{name}} and {{date}} are substituted — a date means a new list every run."
              }
              full
            >
              <div className="flex flex-col gap-2 sm:flex-row">
                <select
                  value={form.leadGroupId ?? ""}
                  onChange={(event) => setForm({ ...form, leadGroupId: event.target.value || null })}
                  className="input sm:w-64"
                >
                  <option value="">A list named below</option>
                  {(groups ?? []).map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name} ({group._count?.leads ?? 0})
                    </option>
                  ))}
                </select>
                <input
                  value={form.groupName ?? ""}
                  onChange={(event) => setForm({ ...form, groupName: event.target.value })}
                  disabled={Boolean(form.leadGroupId)}
                  placeholder="{{name}}"
                  className="input flex-1 disabled:opacity-40"
                />
              </div>
            </Field>
          </div>

          <details className="mt-4 rounded-2xl border border-line bg-white">
            <summary className="cursor-pointer px-4 py-3 font-mono text-[10px] uppercase tracking-[.14em] text-muted">
              Field map (only if an actor names things unusually)
            </summary>
            <div className="border-t border-line p-4">
              <p className="mb-2 text-xs text-muted">
                Lead field to a path in the row, e.g.{" "}
                <code className="font-mono">{'{ "contactEmail": "contact.primaryEmail" }'}</code>. Overrides everything else.
              </p>
              <textarea
                rows={6}
                spellCheck={false}
                value={fieldMapText}
                onChange={(event) => setFieldMapText(event.target.value)}
                placeholder="{}"
                className="code-input"
              />
              {fieldMapError && <p className="mt-1 text-xs text-danger-text">{fieldMapError}</p>}
            </div>
          </details>
        </section>

        <section>
          <SectionTitle>Quality gate</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Max leads per run">
              <input
                type="number"
                min={1}
                max={1000}
                value={form.maxItems}
                onChange={(event) => setForm({ ...form, maxItems: Number(event.target.value) })}
                className="input"
              />
            </Field>
            <Field label="Minimum score to keep" hint="Below this, the row is dropped instead of saved.">
              <input
                type="number"
                min={0}
                max={100}
                value={form.minScore}
                onChange={(event) => setForm({ ...form, minScore: Number(event.target.value) })}
                className="input"
              />
            </Field>
            <Field label="Auto-qualify above" hint="Straight to QUALIFYING rather than NEW.">
              <input
                type="number"
                min={0}
                max={100}
                value={form.qualifyScore}
                disabled={!form.autoQualify}
                onChange={(event) => setForm({ ...form, qualifyScore: Number(event.target.value) })}
                className="input disabled:opacity-40"
              />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap gap-6">
            <Toggle
              checked={form.autoQualify}
              onChange={(next) => setForm({ ...form, autoQualify: next })}
              label="Auto-qualify strong leads"
            />
            <Toggle checked={form.enabled} onChange={(next) => setForm({ ...form, enabled: next })} label="Source enabled" />
          </div>
        </section>

        <section>
          <SectionTitle>Daily schedule</SectionTitle>
          <Toggle
            checked={form.scheduleEnabled}
            onChange={(next) => setForm({ ...form, scheduleEnabled: next })}
            label="Run automatically every day"
          />

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {form.scheduleTimes.map((time) => (
              <span key={time} className="inline-flex items-center gap-2 bg-ink px-2 py-1 font-mono text-[11px] text-cream">
                {time}
                <button
                  type="button"
                  aria-label={`Remove ${time}`}
                  onClick={() => setForm({ ...form, scheduleTimes: form.scheduleTimes.filter((entry) => entry !== time) })}
                  className="text-cream/60 hover:text-cream"
                >
                  ×
                </button>
              </span>
            ))}
            {form.scheduleTimes.length === 0 && <span className="text-xs text-muted">No times set — manual runs only.</span>}
          </div>

          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Add a run time" hint="Up to six a day.">
              <input
                type="time"
                className="input"
                disabled={form.scheduleTimes.length >= 6}
                onChange={(event) => {
                  addTime(event.target.value);
                  event.target.value = "";
                }}
              />
            </Field>
            <Field label="Timezone">
              <input
                list="timezone-options"
                value={form.timezone}
                onChange={(event) => setForm({ ...form, timezone: event.target.value })}
                className="input"
              />
              <datalist id="timezone-options">
                {timezones().map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </Field>
          </div>
        </section>

        {preview && <PreviewPanel preview={preview} />}
      </div>
    </Drawer>
  );
}

function PreviewPanel({ preview }: { preview: MappingPreview }) {
  return (
    <section>
      <SectionTitle>How the last run's rows read</SectionTitle>
      <div className="space-y-3">
        {preview.items.map((item, index) => {
          const lead = item.lead as Record<string, unknown> | undefined;
          return (
            <div key={index} className="rounded-2xl border border-line bg-white p-4 text-sm">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-medium">{(lead?.contactName as string) ?? "Unreadable row"}</span>
                {item.score != null && <Badge tone={item.wouldSave ? "positive" : "muted"}>score {item.score}</Badge>}
                {item.skipped && <Badge tone="muted">skipped: {item.skipped}</Badge>}
              </div>
              {lead && (
                <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-xs text-muted">
                  {(["contactEmail", "contactPhone", "website", "city", "category"] as const).map((field) => (
                    <div key={field} className="contents">
                      <dt className="font-mono text-[10px] uppercase tracking-[.1em] text-muted">{field}</dt>
                      <dd className="truncate">{(lead[field] as string) ?? "—"}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[.16em] text-muted">{children}</h3>;
}

/** Validation for the JSON textareas — a bad paste should say so, not 400 later. */
function jsonError(text: string, expect: "object"): string | null {
  try {
    const parsed = JSON.parse(text);
    if (expect === "object" && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
      return "Expected a JSON object, like { \"key\": \"value\" }";
    }
    return null;
  } catch (err) {
    return `Invalid JSON — ${(err as Error).message}`;
  }
}
