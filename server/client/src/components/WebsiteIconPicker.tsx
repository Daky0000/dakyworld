import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { IconChoice } from "../lib/types";
import { ICON_LIBRARY, libraryIcon, libraryIconMarkup, safeIconSrc } from "../../../src/shared/websiteIcons";
import { fontIconName, iconPreviewSrc, svgPreviewSrc } from "../lib/websiteIconPreview";

type Asset = { id: string; filename: string; url: string; preview: string; contentType?: string };

/**
 * The icon on a button, or an icon standing by itself: see it, and change it.
 *
 * A change is a *choice* (a library icon by name, or an image file) and never
 * markup. The server turns the choice into the SVG or `<img>` it writes, so
 * the only SVG that can reach somebody's page through here is one from the
 * library. Everything else arrives as an image file, which the upload has
 * already rebuilt through the sanitiser.
 */
export function WebsiteIconPicker({
  siteId,
  publicUrl,
  current,
  currentType,
  addable,
  position,
  choice,
  choicePosition,
  readOnly,
  onChoose,
  onReset,
  onOpenMediaLibrary,
}: {
  siteId?: string;
  publicUrl: string;
  /** The icon as the page draws it now; absent when there is none. */
  current?: string;
  currentType?: "svg" | "img" | "font";
  /** A button with words and no icon yet. */
  addable?: boolean;
  /** The side the current icon sits on. */
  position?: "start" | "end";
  /** What has been chosen in this draft: undefined for unchanged, null for removed. */
  choice: IconChoice | null | undefined;
  choicePosition?: "start" | "end";
  readOnly: boolean;
  onChoose: (next: IconChoice | null, side?: "start" | "end") => void;
  onReset: () => void;
  onOpenMediaLibrary?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"library" | "images">("library");
  const [query, setQuery] = useState("");
  const [address, setAddress] = useState("");
  const [side, setSide] = useState<"start" | "end">(choicePosition ?? "end");

  const assets = useQuery({
    queryKey: ["website", "assets", siteId, "icon-picker"],
    queryFn: () => api.get<Asset[]>(`/website/sites/${siteId}/assets`),
    enabled: open && tab === "images" && Boolean(siteId),
  });
  const previewFor = useMemo(() => new Map((assets.data ?? []).map((asset) => [asset.url, asset.preview])), [assets.data]);

  const matching = useMemo(() => {
    const words = query.trim().toLowerCase();
    return words ? ICON_LIBRARY.filter((icon) => `${icon.name} ${icon.label}`.toLowerCase().includes(words)) : ICON_LIBRARY;
  }, [query]);

  // What to draw in the preview tile: the draft's choice when there is one,
  // otherwise the page's own icon.
  const shown = (() => {
    if (choice === null) return { src: null as string | null, label: "No icon" };
    if (choice && "library" in choice) {
      const icon = libraryIcon(choice.library);
      return { src: icon ? svgPreviewSrc(libraryIconMarkup(icon)) : null, label: icon?.label ?? choice.library };
    }
    if (choice && "src" in choice) {
      let src: string | null = previewFor.get(choice.src) ?? null;
      if (!src) {
        try { src = new URL(choice.src, `${publicUrl.replace(/\/+$/, "")}/`).href; } catch { src = null; }
      }
      return { src, label: choice.src.split("/").pop() || "Image" };
    }
    if (!current) return { src: null, label: addable ? "No icon yet" : "No icon" };
    const src = iconPreviewSrc(current, publicUrl);
    return { src, label: src ? (currentType === "img" ? "Image icon" : "Current icon") : `Icon font: ${fontIconName(current)}` };
  })();

  const has = choice === undefined ? Boolean(current) : choice !== null;
  const changed = choice !== undefined;
  const choose = (next: IconChoice | null) => {
    onChoose(next, !current ? side : undefined);
    setOpen(false);
  };

  return (
    <div className="mt-3 rounded-xl border border-line bg-white p-3">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] border border-line bg-cream" aria-hidden="true">
          {shown.src ? (
            <img src={shown.src} alt="" className="h-6 w-6 object-contain" onError={(event) => ((event.target as HTMLImageElement).style.visibility = "hidden")} />
          ) : (
            <span className="text-[10px] text-muted">{has ? "Aa" : "None"}</span>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-bold uppercase tracking-[.08em] text-muted">Icon</div>
          <div className="truncate text-sm text-ink">{shown.label}</div>
          {currentType === "font" && choice === undefined && (
            <div className="text-[11px] text-muted">Drawn by the site's icon font. Choose one below to replace it.</div>
          )}
        </div>
        {changed && !readOnly && (
          <button type="button" className="text-xs text-muted underline" onClick={onReset}>
            Undo
          </button>
        )}
      </div>

      {!readOnly && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className="rounded-[10px] bg-ink px-3 py-1.5 text-xs font-semibold text-cream" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
            {has ? "Change icon" : "Add an icon"}
          </button>
          {has && (current || choice) && (
            <button type="button" className="rounded-[10px] border border-line px-3 py-1.5 text-xs font-semibold text-ink" onClick={() => choose(null)}>
              Remove icon
            </button>
          )}
          {!current && addable && (
            <div role="group" aria-label="Which side of the words" className="ml-auto inline-flex rounded-full border border-line p-0.5 text-[11px]">
              {(["start", "end"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={side === value}
                  className={`rounded-full px-2.5 py-1 ${side === value ? "bg-ink text-cream" : "text-ink"}`}
                  onClick={() => {
                    setSide(value);
                    if (choice) onChoose(choice, value);
                  }}
                >
                  {value === "start" ? "Before words" : "After words"}
                </button>
              ))}
            </div>
          )}
          {position && current && <span className="ml-auto text-[11px] text-muted">{position === "start" ? "Before the words" : "After the words"}</span>}
        </div>
      )}

      {open && !readOnly && (
        <div className="mt-3 border-t border-line pt-3">
          <div role="tablist" className="mb-2 inline-flex rounded-full border border-line p-0.5 text-xs">
            {(["library", "images"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={`rounded-full px-3 py-1 ${tab === value ? "bg-ink text-cream" : "text-ink"}`}
                onClick={() => setTab(value)}
              >
                {value === "library" ? "Icons" : "Your images"}
              </button>
            ))}
          </div>

          {tab === "library" ? (
            <>
              <input
                className="mb-2 w-full rounded-[10px] border border-line px-2.5 py-1.5 text-sm"
                placeholder="Search icons: arrow, phone, cart…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search icons"
              />
              <div className="grid max-h-56 grid-cols-6 gap-1.5 overflow-y-auto">
                {matching.map((icon) => {
                  const src = svgPreviewSrc(libraryIconMarkup(icon));
                  const selected = choice !== null && choice !== undefined && "library" in choice && choice.library === icon.name;
                  return (
                    <button
                      key={icon.name}
                      type="button"
                      title={icon.label}
                      aria-label={icon.label}
                      aria-pressed={selected}
                      className={`grid aspect-square place-items-center rounded-[10px] border ${selected ? "border-blue bg-blue/10" : "border-line hover:border-ink"}`}
                      onClick={() => choose({ library: icon.name })}
                    >
                      {src && <img src={src} alt="" className="h-5 w-5" />}
                    </button>
                  );
                })}
                {!matching.length && <p className="col-span-6 text-xs text-muted">No icon by that name.</p>}
              </div>
            </>
          ) : (
            <>
              {onOpenMediaLibrary && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenMediaLibrary();
                    setOpen(false);
                  }}
                  className="mb-2.5 w-full rounded-lg bg-blue px-3 py-1.5 text-center text-xs font-semibold text-white shadow-2xs transition hover:opacity-90"
                >
                  Choose from Media Library / Upload
                </button>
              )}
              {!siteId ? (
                <p className="text-xs text-muted">Images are available once the site is loaded.</p>
              ) : assets.isLoading ? (
                <p className="text-xs text-muted">Loading your images…</p>
              ) : (
                <div className="grid max-h-56 grid-cols-4 gap-1.5 overflow-y-auto">
                  {(assets.data ?? []).map((asset) => (
                    <button
                      key={asset.id}
                      type="button"
                      title={asset.filename}
                      className="grid aspect-square place-items-center overflow-hidden rounded-[10px] border border-line bg-cream p-1 hover:border-ink"
                      onClick={() => choose({ src: asset.url })}
                    >
                      <img src={asset.preview} alt={asset.filename} className="max-h-full max-w-full object-contain" />
                    </button>
                  ))}
                  {!(assets.data ?? []).length && <p className="col-span-4 text-xs text-muted">No images yet. Upload an SVG or PNG in the Media Library.</p>}
                </div>
              )}
              <form
                className="mt-2 flex gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  const src = safeIconSrc(address);
                  if (src) choose({ src });
                }}
              >
                <input
                  className="min-w-0 flex-1 rounded-[10px] border border-line px-2.5 py-1.5 font-mono text-xs"
                  placeholder="/images/icon.svg or https://…"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  aria-label="Image address"
                />
                <button type="submit" disabled={!safeIconSrc(address)} className="rounded-[10px] border border-line px-2.5 text-xs font-semibold disabled:opacity-50">
                  Use
                </button>
              </form>
            </>
          )}
        </div>
      )}
    </div>
  );
}
