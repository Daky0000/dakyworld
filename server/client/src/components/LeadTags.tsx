import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { LeadTag, LeadTagList, TagColour } from "../lib/types";
import { Button, Drawer, EmptyState, Field } from "./ui";

/**
 * Tags, everywhere they appear.
 *
 * A tag has been on a lead since the scrapers landed and nothing ever showed
 * it: a capture wrote the business category into the array, an import wrote
 * whatever a "Labels" column held, and there was no list of what existed, no
 * way to filter by one, and no way to rename one. This file is the half that
 * was missing — the chip, the picker, and the screen that manages the
 * vocabulary.
 *
 * The registry is server-side (`server/src/services/leadTags.ts`) and the
 * arrays hold the **slug**, never the label, which is what makes a rename cost
 * one row instead of an update across every lead carrying it. So everything
 * here looks a label up by slug and falls back to the slug itself: a tag
 * written a second ago by a scrape is renderable before the registry query has
 * come back.
 */

/** The palette, as Tailwind classes. Lime is absent on purpose — it is the action colour. */
const SWATCH: Record<TagColour, string> = {
  blue: "border-blue/30 bg-blue/10 text-blue",
  cyan: "border-cyan/40 bg-cyan/15 text-ink",
  ink: "border-line-strong bg-sunken text-muted",
  amber: "border-warn-line bg-warn-surface text-warn-text",
  emerald: "border-positive-line bg-positive-surface text-positive-text",
  red: "border-danger-line bg-danger-surface text-danger-text",
};

const NEUTRAL = "border-line-strong bg-sunken text-muted";

export function useLeadTags() {
  return useQuery({
    queryKey: ["lead-tags"],
    queryFn: () => api.get<LeadTagList>("/leads/tags"),
    // The vocabulary changes when a capture runs, not when somebody clicks —
    // no need to re-ask on every mount.
    staleTime: 60_000,
  });
}

export function useTagLookup(): Map<string, LeadTag> {
  const { data } = useLeadTags();
  return new Map((data?.tags ?? []).map((tag) => [tag.slug, tag]));
}

/** A tag's label, or the slug when the registry hasn't caught up with it yet. */
export function tagLabel(slug: string, lookup: Map<string, LeadTag>): string {
  return lookup.get(slug)?.label ?? slug.replace(/-/g, " ");
}

export function TagChip({
  slug,
  lookup,
  onRemove,
  onClick,
  active,
}: {
  slug: string;
  lookup?: Map<string, LeadTag>;
  /** Shown as an × when given. */
  onRemove?: () => void;
  onClick?: () => void;
  active?: boolean;
}) {
  const tag = lookup?.get(slug);
  const tone = active ? "border-ink bg-ink text-cream" : tag?.colour ? SWATCH[tag.colour] : NEUTRAL;
  const label = tag?.label ?? slug.replace(/-/g, " ");

  return (
    <span
      className={`inline-flex items-center gap-1 border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[.08em] ${tone} ${
        onClick ? "cursor-pointer transition hover:border-ink/40" : ""
      }`}
      onClick={onClick}
      title={tag?.description ?? undefined}
    >
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="opacity-50 transition hover:opacity-100"
          aria-label={`Remove ${label}`}
        >
          ×
        </button>
      )}
    </span>
  );
}

/**
 * Picks tags from the registry, and coins a new one by typing it.
 *
 * Coining from here rather than only from the manager is deliberate: the moment
 * you want a tag is the moment you are looking at the lead that needs it, and a
 * picker that makes you leave to create one is a picker people work around by
 * not tagging.
 */
export function TagPicker({
  value,
  onChange,
  placeholder = "Add a tag…",
}: {
  /** Slugs. */
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const { data } = useLeadTags();
  const lookup = useTagLookup();
  const [typed, setTyped] = useState("");

  const all = data?.tags ?? [];
  const available = all.filter((tag) => !value.includes(tag.slug));
  const matching = typed.trim()
    ? available.filter((tag) => tag.label.toLowerCase().includes(typed.trim().toLowerCase()))
    : available.slice(0, 12);

  // The server normalises whatever is typed, so this only has to be close
  // enough to spot a tag that already exists under a different spelling.
  const asSlug = typed
    .trim()
    .toLowerCase()
    .replace(/[^\da-z]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const isNew = asSlug.length > 0 && !all.some((tag) => tag.slug === asSlug);

  const add = (slug: string) => {
    if (!slug || value.includes(slug)) return;
    onChange([...value, slug]);
    setTyped("");
  };

  return (
    <div>
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {value.map((slug) => (
            <TagChip key={slug} slug={slug} lookup={lookup} onRemove={() => onChange(value.filter((entry) => entry !== slug))} />
          ))}
        </div>
      )}

      <input
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          // The exact match wins over creating a near-duplicate of it.
          add(matching[0]?.slug ?? asSlug);
        }}
        placeholder={placeholder}
        className="rounded-[10px] w-full border border-line-strong px-2 py-1 text-sm outline-none transition focus:border-ink/50"
      />

      {(matching.length > 0 || isNew) && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {isNew && (
            <button
              type="button"
              onClick={() => add(asSlug)}
              className="rounded-xl border border-blue/40 bg-blue/5 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[.08em] text-blue transition hover:bg-blue/10"
            >
              + {typed.trim()}
            </button>
          )}
          {matching.map((tag) => (
            <TagChip key={tag.slug} slug={tag.slug} lookup={lookup} onClick={() => add(tag.slug)} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The vocabulary, and what uses it.
 *
 * The counts are the point of this screen. A tag on four hundred leads is a
 * segment; a tag on one is a typo, and until they were counted there was no way
 * to tell them apart. `auto` marks the ones a capture or an import coined
 * rather than the Owner — those are the ones worth renaming or clearing out.
 */
export function TagManager({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useLeadTags();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["lead-tags"] });
    void qc.invalidateQueries({ queryKey: ["leads"] });
    void qc.invalidateQueries({ queryKey: ["lead-groups"] });
  };

  const create = useMutation({
    mutationFn: (body: { label: string; colour: TagColour | null; description: string | null }) => api.post("/leads/tags", body),
    onSuccess: () => {
      invalidate();
      setCreating(false);
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/leads/tags/${id}`, body),
    onSuccess: () => {
      invalidate();
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/leads/tags/${id}`),
    onSuccess: invalidate,
  });

  const tags = data?.tags ?? [];
  const colours = data?.colours ?? [];

  return (
    <Drawer open onClose={onClose} title="Tags" subtitle="The vocabulary for leads and lists" wide>
      <p className="text-sm text-muted">
        Labels on leads and on lists. A tag's name can be changed freely — every lead carrying it follows, because what is stored is
        the tag rather than the word. Renaming one is safe; deleting one takes it off everything that had it.
      </p>

      <div className="mt-4 flex items-center gap-3">
        <Button size="sm" onClick={() => setCreating((open) => !open)}>
          {creating ? "Cancel" : "New tag"}
        </Button>
        <span className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">
          {tags.length} tag{tags.length === 1 ? "" : "s"} ·{" "}
          {tags.filter((tag) => tag.autoCreated).length} coined by a capture
        </span>
      </div>

      {creating && (
        <TagForm
          colours={colours}
          pending={create.isPending}
          error={create.error}
          onSubmit={(body) => create.mutate(body)}
          onCancel={() => setCreating(false)}
        />
      )}

      <div className="mt-5 space-y-2">
        {isLoading && <p className="text-sm text-muted">Loading…</p>}
        {!isLoading && tags.length === 0 && (
          <EmptyState message="No tags yet. Tag a lead, or make one here — a capture will also coin one per business category." />
        )}

        {tags.map((tag) =>
          editing === tag.id ? (
            <TagForm
              key={tag.id}
              tag={tag}
              colours={colours}
              pending={update.isPending}
              error={update.error}
              onSubmit={(body) => update.mutate({ id: tag.id, body })}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <div key={tag.id} className="rounded-xl flex flex-wrap items-center gap-3 border border-line px-3 py-2">
              <TagChip slug={tag.slug} lookup={new Map([[tag.slug, tag]])} />
              <span className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">
                {tag.leads} lead{tag.leads === 1 ? "" : "s"}
                {tag.groups > 0 ? ` · ${tag.groups} list${tag.groups === 1 ? "" : "s"}` : ""}
              </span>
              {tag.autoCreated && (
                <span className="font-mono text-[10px] uppercase tracking-[.14em] text-muted" title="Coined by a capture, an import or a webhook">
                  auto
                </span>
              )}
              {tag.description && <span className="min-w-0 flex-1 truncate text-xs text-muted">{tag.description}</span>}
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setEditing(tag.id)}
                className="font-mono text-[10px] uppercase tracking-[.14em] text-muted transition hover:text-ink"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => {
                  const where = [tag.leads ? `${tag.leads} lead(s)` : "", tag.groups ? `${tag.groups} list(s)` : ""]
                    .filter(Boolean)
                    .join(" and ");
                  if (confirm(where ? `Delete “${tag.label}”? It comes off ${where}.` : `Delete “${tag.label}”?`)) {
                    remove.mutate(tag.id);
                  }
                }}
                disabled={remove.isPending}
                className="font-mono text-[10px] uppercase tracking-[.14em] text-danger-text/70 transition hover:text-danger-text"
              >
                Delete
              </button>
            </div>
          ),
        )}
      </div>

      {remove.error instanceof Error && (
        <p className="mt-3 rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{remove.error.message}</p>
      )}
    </Drawer>
  );
}

function TagForm({
  tag,
  colours,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  tag?: LeadTag;
  colours: TagColour[];
  pending: boolean;
  error: unknown;
  onSubmit: (body: { label: string; colour: TagColour | null; description: string | null }) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(tag?.label ?? "");
  const [colour, setColour] = useState<TagColour | "">(tag?.colour ?? "");
  const [description, setDescription] = useState(tag?.description ?? "");

  return (
    <form
      className="rounded-xl mt-3 space-y-3 border border-blue/30 bg-blue/5 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!label.trim()) return;
        onSubmit({ label: label.trim(), colour: colour || null, description: description.trim() || null });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input value={label} onChange={(event) => setLabel(event.target.value)} className="input" placeholder="Cold outreach" />
        </Field>
        <Field label="Colour" hint="Blank is neutral grey.">
          <select value={colour} onChange={(event) => setColour(event.target.value as TagColour | "")} className="input">
            <option value="">None</option>
            {colours.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="What it means" hint="Shown when somebody hovers the tag. Optional.">
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="input"
          placeholder="Businesses we approached cold, no prior contact"
        />
      </Field>

      {tag && (
        <p className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">
          Stored as {tag.slug} — renaming does not change that, so nothing loses the tag.
        </p>
      )}
      {error instanceof Error && <p className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{error.message}</p>}

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending || !label.trim()}>
          {pending ? "Saving…" : tag ? "Save" : "Create"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
