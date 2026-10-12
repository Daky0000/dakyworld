import { useEffect, useState, type ReactNode } from "react";
import {
  MEDIA_ATTRIBUTES, TAG_LABEL, attributeProblem, mediaKind, readMediaTime, writeMediaTime, type ElementSettingsChange,
} from "../../../src/shared/websiteElementSettings";
import { ICON } from "./StyleControls";
import type { SiteFieldRow } from "../lib/types";

/**
 * The General tab's Settings section — the same five rows for every element,
 * as in the page builder it follows: HTML tag, Link, ID, Attributes and
 * Display conditions — and, for a video or an audio player, its own Content.
 *
 * The tag and the attributes are markup, not style, so each change is a
 * structure change on the server: it is checked against the shared allowlist
 * (`shared/websiteElementSettings.ts`), written into the draft document with
 * the page's field identities pinned, and undone like a move. That is also why
 * boxes here save when you leave them rather than on every keystroke.
 */

export type Visibility = { desktop: boolean; tablet: boolean; mobile: boolean };

export function ElementSettings({
  field,
  readOnly,
  designer,
  link,
  visibility,
  onVisibility,
  onSettings,
  lockedReason,
}: {
  field: SiteFieldRow;
  readOnly: boolean;
  /** Designer controls: the tag and free attributes are shown only then. */
  designer: boolean;
  /** The link control, which the editor owns: a destination is a field value, not a setting. */
  link?: ReactNode;
  visibility: Visibility;
  onVisibility: (next: Visibility) => void;
  onSettings: (change: ElementSettingsChange) => void;
  /** Why this element's markup cannot be changed from this page, when it cannot. */
  lockedReason?: string;
}) {
  const markup = field.structure !== undefined && !lockedReason;
  const media = mediaKind(field.tag);
  const attributes = field.attributes ?? [];
  const id = attributes.find((attr) => attr.name === "id")?.value ?? "";
  const free = attributes.filter((attr) => attr.name !== "id" && !(media && MEDIA_ATTRIBUTES[media].includes(attr.name)));
  const locked = lockedReason ?? (field.structure === undefined ? "This page is built from its source files, so its markup is changed in the code." : null);
  return (
    <div className="dx-stack">
      {designer && field.tagOptions && field.tagOptions.length > 1 && (
        <label className="dx-f">
          <span className="dx-fl"><span className="dx-lt">HTML tag</span></span>
          <select
            aria-label="HTML tag"
            value={field.tag}
            disabled={readOnly || !markup}
            onChange={(event) => onSettings({ tag: event.target.value })}
          >
            {field.tagOptions.map((tag) => <option key={tag} value={tag}>{TAG_LABEL[tag] ?? tag}</option>)}
          </select>
          <span className="dx-hint">{/^h[1-6]$/.test(field.tag) ? "The heading level: one H1 per page, then H2 for sections and H3 inside them." : "What the block means to search engines and screen readers. It looks the same unless the site's CSS styles that tag."}</span>
        </label>
      )}

      {link}

      {designer && (
        <TextSetting
          label="ID"
          value={id}
          placeholder="e.g. contact"
          disabled={readOnly || !markup}
          hint="For links to this spot (#contact) and for custom code. A block with an ID can't be duplicated, because an ID has to be unique."
          check={(next) => (next ? attributeProblem("id", next, field.tag) : null)}
          onSave={(next) => onSettings({ attributes: { id: next || null } })}
        />
      )}

      {designer && <Attributes tag={field.tag} items={free} disabled={readOnly || !markup} onSave={(changes) => onSettings({ attributes: changes })} />}

      <div className="dx-f">
        <span className="dx-fl"><span className="dx-lt">Display conditions</span></span>
        <div className="dx-devs" role="group" aria-label="Visible on">
          {(["desktop", "tablet", "mobile"] as const).map((device) => (
            <button
              key={device}
              type="button"
              aria-pressed={visibility[device]}
              aria-label={`Show on ${device === "mobile" ? "phone" : device}`}
              disabled={readOnly}
              onClick={() => onVisibility({ ...visibility, [device]: !visibility[device] })}
            >
              {visibility[device] ? ICON.eye : ICON.eyeOff}
              <span>{device === "mobile" ? "Phone" : device === "tablet" ? "Tablet" : "Desktop"}</span>
            </button>
          ))}
        </div>
        <span className="dx-hint">
          {!visibility.desktop && !visibility.tablet && !visibility.mobile
            ? "Hidden on every screen. Find it again under Layers."
            : "Hide it on a screen size and it is not shown there at all. Pages here are files rather than an app, so rules about dates or signed-in visitors aren't available."}
        </span>
      </div>

      {locked && (designer || field.tagOptions) && <p className="dx-hint">{locked}</p>}
    </div>
  );
}

/** A box that saves when it is left, with the reason it cannot when it cannot. */
function TextSetting({ label, value, placeholder, disabled, hint, check, onSave }: { label: string; value: string; placeholder?: string; disabled: boolean; hint?: string; check: (next: string) => string | null; onSave: (next: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const problem = text.trim() !== value ? check(text.trim()) : null;
  const save = () => {
    const next = text.trim();
    if (next === value || problem) return;
    onSave(next);
  };
  return (
    <div className="dx-f">
      <span className="dx-fl"><label className="dx-lt">{label}</label></span>
      <div className="dx-inp">
        <input
          type="text"
          aria-label={label}
          disabled={disabled}
          value={text}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); save(); }
            if (event.key === "Escape") setText(value);
          }}
        />
      </div>
      {problem ? <span className="dx-err" role="alert">{problem}</span> : hint && <span className="dx-hint">{hint}</span>}
    </div>
  );
}

/** Custom attributes as `key="value"` rows: click one to change it, × to take it away, + to add. */
function Attributes({ tag, items, disabled, onSave }: { tag: string; items: { name: string; value: string }[]; disabled: boolean; onSave: (changes: Record<string, string | null>) => void }) {
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const begin = (index: number | "new") => {
    setEditing(index);
    setName(index === "new" ? "" : items[index]!.name);
    setValue(index === "new" ? "" : items[index]!.value);
  };
  const original = editing !== null && editing !== "new" ? items[editing] : undefined;
  const clash = editing !== null && items.some((item, index) => index !== editing && item.name === name.trim().toLowerCase());
  const problem = editing === null ? null : clash ? "This element already has that attribute." : name.trim() ? attributeProblem(name, value, tag) : null;
  const save = () => {
    const key = name.trim().toLowerCase();
    if (!key || problem) return;
    const changes: Record<string, string | null> = { [key]: value };
    if (original && original.name !== key) changes[original.name] = null;
    onSave(changes);
    setEditing(null);
  };
  return (
    <div className="dx-rep">
      <div className="dx-fl">
        <span className="dx-lab"><label>Attributes</label></span>
        <button type="button" className="dx-add" aria-label="Add attribute" disabled={disabled} onClick={() => begin("new")}>+</button>
      </div>
      {items.map((item, index) => (
        <div key={item.name} className="dx-item">
          <div className="dx-item-row">
            <button type="button" className="dx-item-sum dx-mono" disabled={disabled} onClick={() => begin(index)}>
              {item.value === "" ? item.name : `${item.name}="${item.value}"`}
            </button>
            <button type="button" className="dx-ib" aria-label={`Remove ${item.name}`} disabled={disabled} onClick={() => onSave({ [item.name]: null })}>×</button>
          </div>
        </div>
      ))}
      {editing !== null && (
        <div className="dx-panel">
          <div className="dx-g2">
            <label className="dx-nf"><span>Name</span><span className="dx-inp"><input type="text" aria-label="Attribute name" value={name} spellCheck={false} placeholder="data-track" onChange={(event) => setName(event.target.value)} /></span></label>
            <label className="dx-nf"><span>Value</span><span className="dx-inp"><input type="text" aria-label="Attribute value" value={value} spellCheck={false} placeholder="hero" onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); save(); } }} /></span></label>
          </div>
          {problem && <span className="dx-err" role="alert">{problem}</span>}
          <div className="dx-g2">
            <button type="button" className="dx-btn dx-pri" disabled={disabled || !name.trim() || Boolean(problem)} onClick={save}>{editing === "new" ? "Add" : "Save"}</button>
            <button type="button" className="dx-btn dx-ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
      {items.length === 0 && editing === null && <span className="dx-hint">data-*, aria-*, role, title, lang… Event handlers, classes and addresses are set elsewhere or not at all.</span>}
    </div>
  );
}

/**
 * A video or audio player's Content: its file, a start and end, and the
 * switches a player has. Each maps straight onto an HTML attribute — autoplay,
 * playsinline, muted, loop, controls, controlslist, preload, poster — and a
 * start and end become a media fragment on the address (`#t=5,20`).
 *
 * The switches are gathered here and sent together when **Apply** is pressed.
 * Each send is a structure change: it reloads the page beside the panel and
 * counts as one edit against the plan's monthly allowance, so eight switches
 * sent one at a time would be eight reloads and eight edits for what somebody
 * thinks of as setting up one video.
 */
export function MediaSettings({
  field,
  readOnly,
  onSettings,
  onPickPoster,
  resolveImage,
  lockedReason,
}: {
  field: SiteFieldRow;
  readOnly: boolean;
  lockedReason?: string;
  onSettings: (change: ElementSettingsChange) => void;
  onPickPoster?: (apply: (url: string) => void) => void;
  resolveImage?: (url: string) => string;
}) {
  const media = mediaKind(field.tag)!;
  const saved = Object.fromEntries((field.attributes ?? []).map((attr) => [attr.name, attr.value])) as Record<string, string>;
  /** What has been changed here and not sent yet: a value to set, or null to remove. */
  const [pending, setPending] = useState<Record<string, string | null>>({});
  // Once a change has been applied the page comes back saying so; what was
  // waiting is then simply what the element has.
  const signature = JSON.stringify(field.attributes ?? []);
  useEffect(() => setPending({}), [signature]);

  const attrs: Record<string, string> = { ...saved };
  for (const [name, value] of Object.entries(pending)) {
    if (value === null) delete attrs[name];
    else attrs[name] = value;
  }
  const has = (name: string) => attrs[name] !== undefined;
  const set = (changes: Record<string, string | null>) =>
    setPending((current) => {
      const next = { ...current, ...changes };
      // A switch put back where it started is not a change.
      for (const [name, value] of Object.entries(next)) if ((saved[name] ?? null) === value) delete next[name];
      return next;
    });
  const src = attrs.src ?? "";
  const time = readMediaTime(src);
  const sources = field.mediaSources ?? 0;
  const disabled = readOnly || field.structure === undefined || Boolean(lockedReason);
  const controls = (attrs.controlslist ?? "").split(/\s+/).filter(Boolean);
  const waiting = Object.keys(pending).length;
  const toggle = (label: string, on: boolean, change: () => void, hint?: string) => (
    <label className="dx-toggle" title={hint}>
      <span>{label}</span>
      <input type="checkbox" checked={on} disabled={disabled} onChange={change} />
    </label>
  );
  return (
    <div className="dx-stack">
      {lockedReason && <p className="dx-hint">{lockedReason}</p>}
      {sources > 1 ? (
        <p className="dx-hint">This {media} lists {sources} files for different browsers, so its file is changed in the page's code. Everything below still applies.</p>
      ) : (
        <>
          <MediaText label={media === "video" ? "Video file" : "Audio file"} value={time.base} placeholder="/media/intro.mp4 or https://…" disabled={disabled} onSave={(base) => set({ src: base ? writeMediaTime(base, time.start, time.end) : null })} tag={field.tag} />
          <div className="dx-g2">
            <MediaNumber label="Start time" value={time.start} disabled={disabled || !time.base} onSave={(start) => set({ src: writeMediaTime(time.base, start, time.end) })} />
            <MediaNumber label="End time" value={time.end} disabled={disabled || !time.base} onSave={(end) => set({ src: writeMediaTime(time.base, time.start, end) })} />
          </div>
        </>
      )}
      {toggle("Autoplay", has("autoplay"), () => set(has("autoplay") ? { autoplay: null } : { autoplay: "", muted: "" }), "Browsers only start a video on their own when it is muted, so turning this on mutes it too.")}
      {media === "video" && has("autoplay") && toggle("Play on mobile", has("playsinline"), () => set({ playsinline: has("playsinline") ? null : "" }))}
      {toggle("Mute", has("muted"), () => set({ muted: has("muted") ? null : "" }))}
      {toggle("Loop", has("loop"), () => set({ loop: has("loop") ? null : "" }))}
      {toggle("Player controls", has("controls"), () => set({ controls: has("controls") ? null : "" }))}
      {toggle("Allow download", !controls.includes("nodownload"), () => {
        const next = controls.includes("nodownload") ? controls.filter((token) => token !== "nodownload") : [...controls, "nodownload"];
        set({ controlslist: next.length ? next.join(" ") : null });
      })}
      <label className="dx-f">
        <span className="dx-fl"><span className="dx-lt">Preload</span></span>
        <select aria-label="Preload" disabled={disabled} value={attrs.preload ?? ""} onChange={(event) => set({ preload: event.target.value || null })}>
          <option value="">Browser default</option>
          <option value="auto">Auto</option>
          <option value="metadata">Metadata</option>
          <option value="none">None (lazy load)</option>
        </select>
      </label>
      {media === "video" && (
        <div className="dx-f">
          {toggle("Poster image", has("poster"), () => (has("poster") ? set({ poster: null }) : onPickPoster?.((url) => set({ poster: url }))))}
          {has("poster") && (
            <>
              <div className="dx-thumb" style={{ backgroundImage: `url("${(resolveImage ? resolveImage(attrs.poster!) : attrs.poster!).replace(/"/g, "")}")` }} />
              <div className="dx-g2">
                <button type="button" className="dx-btn dx-soft" disabled={disabled || !onPickPoster} onClick={() => onPickPoster?.((url) => set({ poster: url }))}>Replace poster</button>
              </div>
            </>
          )}
        </div>
      )}
      <div className="dx-g2">
        <button type="button" className="dx-btn dx-pri" disabled={disabled || waiting === 0} onClick={() => onSettings({ attributes: pending })}>
          {waiting ? `Apply ${waiting} change${waiting === 1 ? "" : "s"}` : "Apply"}
        </button>
        <button type="button" className="dx-btn dx-ghost" disabled={disabled || waiting === 0} onClick={() => setPending({})}>Reset</button>
      </div>
      <p className="dx-hint">{waiting ? "Nothing is changed until you press Apply." : `A ${media} is added by its address: put the file where the site keeps its media, then paste its path here.`}</p>
    </div>
  );
}

function MediaText({ label, value, placeholder, disabled, tag, onSave }: { label: string; value: string; placeholder: string; disabled: boolean; tag: string; onSave: (next: string) => void }) {
  return (
    <TextSetting
      label={label}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      check={(next) => (next ? attributeProblem("src", next, tag) : null)}
      onSave={onSave}
    />
  );
}

function MediaNumber({ label, value, disabled, onSave }: { label: string; value: number | null; disabled: boolean; onSave: (next: number | null) => void }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => setText(value === null ? "" : String(value)), [value]);
  const save = () => {
    const trimmed = text.trim();
    const next = trimmed === "" ? null : Number(trimmed);
    if (next !== null && (!Number.isFinite(next) || next < 0 || next > 100000)) return setText(value === null ? "" : String(value));
    if (next !== value) onSave(next);
  };
  return (
    <label className="dx-nf">
      <span>{label}</span>
      <span className="dx-inp">
        <input type="text" inputMode="decimal" aria-label={label} disabled={disabled} value={text} placeholder="sec" onChange={(event) => setText(event.target.value)} onBlur={save} onKeyDown={(event) => { if (event.key === "Enter") save(); }} />
        <em>s</em>
      </span>
    </label>
  );
}
