import { useMemo } from "react";
import type { FieldEdit, SiteFieldRow } from "../lib/types";
import { Badge } from "./ui";
import { WebsiteRichText } from "./WebsiteRichText";
import { WebsiteIconPicker } from "./WebsiteIconPicker";
import { ButtonControls } from "./WebsiteButtonControls";
import { IconImage } from "./WebsiteIcons";

const INPUT =
  "w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-blue focus:ring-2 focus:ring-blue/20";

export function FieldRow({
  field,
  edit,
  problem,
  siteId,
  publicUrl,
  resolveImagePreview,
  links,
  onChange,
  onNameFields,
  naming,
  readOnly,
  bare,
  onOpenMediaLibrary,
  computedBackgroundUrl,
}: {
  field: SiteFieldRow;
  edit: FieldEdit | undefined;
  problem: string | undefined;
  siteId?: string;
  publicUrl: string;
  resolveImagePreview?: (url: string) => string;
  /** The site's own pages, so a destination is picked rather than spelled. */
  links: Array<{ path: string; title: string }>;
  onChange: (next: FieldEdit) => void;
  /** Offered only on a field the editor could unlock by naming it in the code.
   * Absent everywhere else, so the button never appears where it cannot help. */
  onNameFields?: () => void;
  naming?: boolean;
  readOnly: boolean;
  /** Inside the visual panel, where the card's own border and title are noise. */
  bare?: boolean;
  onOpenMediaLibrary?: () => void;
  computedBackgroundUrl?: string;
}) {
  readOnly = readOnly || field.sourceManaged === true;
  const value = edit?.value ?? field.value;
  const href = edit?.href ?? field.href ?? "";
  const alt = edit?.alt ?? field.alt ?? "";
  const changed = edit !== undefined && Object.keys(edit).length > 0;

  const imageSrc = useMemo(() => {
    if (field.kind !== "image") return null;
    if (resolveImagePreview) return resolveImagePreview(value);
    try {
      return new URL(value, `${publicUrl.replace(/\/+$/, "")}/`).toString();
    } catch {
      return null;
    }
  }, [field.kind, value, publicUrl, resolveImagePreview]);

  if (field.kind === "container") {
    const rawBg = edit?.style ?? field.style ?? computedBackgroundUrl ?? "";
    const bgMatch = /url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(rawBg);
    const containerBgUrl = bgMatch?.[1] || (/^(?:https?:|\/|data:image\/)/i.test(rawBg.trim()) ? rawBg.trim() : "");
    const previewSrc = containerBgUrl ? (resolveImagePreview ? resolveImagePreview(containerBgUrl) : containerBgUrl) : null;
    return (
      <div className="space-y-2">
        {previewSrc && (
          <div className="flex items-center gap-3 rounded-xl border border-line bg-sunken p-2.5">
            <img src={previewSrc} alt="" className="h-12 w-12 rounded-lg border border-line bg-white object-cover" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
            <div className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold text-ink">Background Image</span>
              <span className="block truncate font-mono text-[10px] text-muted">{containerBgUrl}</span>
            </div>
            {onOpenMediaLibrary && !readOnly && (
              <button
                type="button"
                onClick={onOpenMediaLibrary}
                className="shrink-0 rounded-lg border border-line bg-white px-2 py-1 text-xs font-semibold text-ink hover:border-blue hover:text-blue"
              >
                Change
              </button>
            )}
          </div>
        )}
        <p className="text-xs leading-relaxed text-muted">Select a child to edit its content, or use the controls below to style this container.</p>
      </div>
    );
  }

  return (
    <div
      className={
        bare
          ? ""
          : `rounded-2xl border p-4 ${problem ? "border-warn-line bg-warn-surface/40" : changed ? "border-blue/40 bg-blue/[.02]" : "border-line bg-white"}`
      }
    >
      {!bare && (
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-xs font-bold uppercase tracking-[.1em] text-muted">{field.label}</span>
          {changed && <Badge tone="warn">Changed</Badge>}
        </div>
      )}
      {bare && changed && (
        <div className="mb-2">
          <Badge tone="warn">Changed</Badge>
        </div>
      )}

      {(field.kind === "richtext" || (field.kind === "text" && field.tag !== "title" && field.tag !== "meta")) && (
        <WebsiteRichText label={field.label} html={value} readOnly={readOnly} onChange={(next) => onChange({ ...edit, value: next })} />
      )}

      {field.kind === "text" && (field.tag === "title" || field.tag === "meta") && (
        <textarea
          className={`${INPUT} resize-y`}
          rows={value.length > 90 ? 3 : 1}
          value={value}
          readOnly={readOnly}
          onChange={(event) => onChange({ ...edit, value: event.target.value })}
        />
      )}

      {(field.kind === "link" || field.kind === "button") && (
        <>
          <div className={`grid gap-2 ${bare ? "" : "sm:grid-cols-2"}`}>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">
                {field.kind === "button" ? "Words on the button" : "Words on the link"}
              </span>
              <WebsiteRichText label={field.label} html={value} readOnly={readOnly || !field.value} onChange={(next) => onChange({ ...edit, value: next })} />
            </label>
            {field.href !== undefined && (
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Where it goes</span>
                <input
                  className={`${INPUT} font-mono text-xs`}
                  value={href}
                  readOnly={readOnly}
                  list={`${field.id}-links`}
                  onChange={(event) => onChange({ ...edit, href: event.target.value })}
                />
                <datalist id={`${field.id}-links`}>
                  {links.map((link) => (
                    <option key={link.path} value={link.path}>
                      {link.title}
                    </option>
                  ))}
                </datalist>
              </label>
            )}
          </div>
          {field.kind === "button" && (
            <ButtonControls field={field} edit={edit} siteId={siteId} publicUrl={publicUrl} onChange={onChange} readOnly={readOnly} />
          )}
        </>
      )}

      {field.kind === "image" && (
        <div className={`flex flex-wrap items-start gap-4 ${bare ? "flex-col" : ""}`}>
          <div className="flex items-center gap-3">
            {imageSrc ? (
              <img
                src={imageSrc}
                alt=""
                className="h-16 w-16 rounded-xl border border-line bg-cream object-contain p-1"
                onError={(event) => ((event.target as HTMLImageElement).style.visibility = "hidden")}
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-line bg-cream text-muted">
                <IconImage size={24} />
              </div>
            )}
            {onOpenMediaLibrary && !readOnly && (
              <button
                type="button"
                onClick={onOpenMediaLibrary}
                className="rounded-lg border border-line bg-white px-2.5 py-1 text-xs font-semibold text-ink transition hover:border-blue hover:text-blue"
              >
                Media Library
              </button>
            )}
          </div>
          <div className={`space-y-2 ${bare ? "w-full" : "min-w-[240px] flex-1"}`}>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Picture file</span>
              <input
                className={`${INPUT} font-mono text-xs`}
                value={value}
                readOnly={readOnly}
                onChange={(event) => onChange({ ...edit, value: event.target.value })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Description, for somebody who cannot see it</span>
              <input
                className={INPUT}
                value={alt}
                readOnly={readOnly}
                placeholder={field.decorative ? "Marked as decoration" : ""}
                onChange={(event) => onChange({ ...edit, alt: event.target.value })}
              />
            </label>
          </div>
        </div>
      )}

      {field.kind === "icon" && (
        <WebsiteIconPicker
          siteId={siteId}
          publicUrl={publicUrl}
          current={field.icon}
          currentType={field.iconType}
          choice={edit?.icon}
          readOnly={readOnly}
          onChoose={(nextIcon) => onChange({ ...edit, icon: nextIcon, ...(nextIcon && "src" in nextIcon ? { value: nextIcon.src } : {}) })}
          onReset={() => {
            const next = { ...edit };
            delete next.icon;
            onChange(next);
          }}
          onOpenMediaLibrary={onOpenMediaLibrary}
        />
      )}

      {field.sourceManaged && (
        <div className="mt-2 rounded-[10px] bg-sunken px-2 py-1 text-xs text-muted">
          <p>{field.sourceNote ?? "This is written by the code that builds this page, so it cannot be changed here."}</p>
          {field.sourceNameable && onNameFields && (
            <button type="button" className="mt-1.5 rounded-[10px] bg-ink px-2 py-1 text-[11px] font-semibold text-cream disabled:opacity-60" disabled={naming} onClick={onNameFields}>
              {naming ? "Naming…" : "Name these fields"}
            </button>
          )}
        </div>
      )}
      {field.note && <p className="mt-2 text-xs text-muted">{field.note}</p>}
      {problem && <p className="mt-2 text-xs font-semibold text-warn-text">{problem}</p>}
    </div>
  );
}
