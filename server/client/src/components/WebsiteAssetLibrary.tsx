import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { SiteSummary } from "../lib/types";
import { Button, PageHeader } from "./ui";
import { useWebsiteAccess } from "./WebsiteMembers";
import { WebsiteTierStatusBanner, notifyTierStatusChanged, useWebsiteTierStatus } from "./WebsiteTierStatusBanner";
import { IconXCircle } from "./WebsiteIcons";

export type CapturedHtmlImage = {
  url: string;
  alt: string;
  preview?: string;
  source?: string;
};

export type WebsiteAssetSelection = { url: string; alt: string; preview?: string };

type Asset = { id: string; filename: string; alt: string; url: string; preview: string; byteSize?: number; contentType?: string };
/** Videos share the library with pictures (uploaded from a video's own settings) but never fill a picture's place. */
const isVideo = (asset: { contentType?: string }) => Boolean(asset.contentType?.startsWith("video/"));
/** Audio the same way, from an audio player's settings. */
const isAudio = (asset: { contentType?: string }) => Boolean(asset.contentType?.startsWith("audio/"));
/** Anything that plays rather than shows: never a picture's replacement. */
const isPlayable = (asset: { contentType?: string }) => isVideo(asset) || isAudio(asset);

/** An audio file has nothing to look at, so its tile is a note and a player to listen with. */
function AudioTile({ asset, controls }: { asset: Asset; controls: boolean }) {
  return (
    <span className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-2">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-muted"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
      {controls && <audio src={asset.preview} controls preload="none" aria-label={asset.filename} className="h-8 w-full" />}
    </span>
  );
}

export function WebsiteAssetLibrary({
  siteId,
  onSelect,
  capturedImages = [],
}: {
  siteId: string;
  onSelect?: (asset: WebsiteAssetSelection) => void;
  capturedImages?: CapturedHtmlImage[];
}) {
  const access = useWebsiteAccess(siteId);
  const { status: tierStatus } = useWebsiteTierStatus(siteId);
  const [activeTab, setActiveTab] = useState<"page" | "library">(capturedImages.length > 0 ? "page" : "library");
  const [candidate, setCandidate] = useState<{ url: string; alt: string; preview: string } | null>(null);
  const [uploadKey, setUploadKey] = useState(0);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [alt, setAlt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [savingUrl, setSavingUrl] = useState<string | null>(null);
  const qc = useQueryClient();
  const assets = useQuery({
    queryKey: ["website", "assets", siteId, tierStatus?.userEmail ?? "default"],
    queryFn: ({ signal }) => api.get<Asset[]>(`/website/sites/${siteId}/assets`, signal),
  });

  const maxUploadBytes = tierStatus?.storage.maxSingleAssetBytes ?? 5_000_000;
  const maxUploadLabel = tierStatus?.storage.maxSingleAssetFormatted ?? "5 MB";

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose an image first.");
      if (file.size > maxUploadBytes) {
        throw new Error(
          `File size (${(file.size / (1024 * 1024)).toFixed(2)} MB) exceeds your ${tierStatus?.tierName ?? "current"} plan's ${maxUploadLabel} per-file limit.`,
        );
      }
      const isSvg = file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg");
      if (!isSvg) {
        const bitmap = await createImageBitmap(file).catch(() => {
          throw new Error("That file could not be opened as an image.");
        });
        if (bitmap.width * bitmap.height > 40_000_000) {
          bitmap.close();
          throw new Error("Use an image smaller than 40 megapixels.");
        }
        bitmap.close();
      }
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("The image could not be read."));
        reader.readAsDataURL(file);
      });
      return api.post<{ id: string; url: string; alt: string }>(`/website/sites/${siteId}/assets`, {
        filename: file.name,
        alt,
        data,
      });
    },
    onSuccess: async (asset) => {
      await qc.invalidateQueries({ queryKey: ["website", "assets", siteId] });
      await qc.invalidateQueries({ queryKey: ["website", "assets", "all"] });
      notifyTierStatusChanged();
      setFile(null);
      setUploadKey((key) => key + 1);
      setPreviewFailed(false);
      if (onSelect) {
        setCandidate({ ...asset, preview: `/api/website/sites/${siteId}/assets/${asset.id}/content` });
      }
    },
  });

  const deleteAsset = useMutation({
    mutationFn: async (assetId: string) => {
      await api.delete(`/website/sites/${siteId}/assets/${assetId}`);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["website", "assets", siteId] });
      await qc.invalidateQueries({ queryKey: ["website", "assets", "all"] });
      notifyTierStatusChanged();
    },
  });

  const saveCapturedToLibrary = async (img: CapturedHtmlImage) => {
    try {
      setSavingUrl(img.url);
      const response = await fetch(img.preview ?? img.url);
      const blob = await response.blob();
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("Could not encode image"));
        reader.readAsDataURL(blob);
      });
      const isSvg = blob.type === "image/svg+xml" || img.url.startsWith("data:image/svg") || /\.svg($|\?)/i.test(img.url);
      const fallbackName = (img.alt || (isSvg ? "captured-icon" : "captured-image"))
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50) || (isSvg ? "captured-icon" : "captured-image");
      const rawName = img.url.startsWith("data:")
        ? fallbackName
        : (img.url.split("/").pop()?.split("?")[0] || fallbackName);
      const ext = isSvg ? "svg" : /\.(png|jpe?g|webp|gif)$/i.test(rawName) ? "" : "png";
      const filename = isSvg
        ? (rawName.toLowerCase().endsWith(".svg") ? rawName : `${rawName}.svg`)
        : (ext ? `${rawName}.${ext}` : rawName);
      await api.post(`/website/sites/${siteId}/assets`, {
        filename,
        alt: img.alt || filename,
        data,
      });
      await qc.invalidateQueries({ queryKey: ["website", "assets", siteId] });
      await qc.invalidateQueries({ queryKey: ["website", "assets", "all"] });
      notifyTierStatusChanged();
    } catch {
      // Ignore CORS fetch errors on external images; user can still select directly by URL
    } finally {
      setSavingUrl(null);
    }
  };

  return (
    <div className="space-y-4">
      <WebsiteTierStatusBanner
        siteId={siteId}
        compact
        onUserSwitched={() => void qc.invalidateQueries({ queryKey: ["website", "assets", siteId] })}
      />
      {capturedImages.length > 0 && (
        <div className="flex items-center gap-1 rounded-xl border border-line bg-sunken p-1">
          <button
            type="button"
            onClick={() => setActiveTab("page")}
            className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "page" ? "bg-white text-ink shadow-xs" : "text-muted hover:text-ink"
            }`}
          >
            Page Media ({capturedImages.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("library")}
            className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "library" ? "bg-white text-ink shadow-xs" : "text-muted hover:text-ink"
            }`}
          >
            Site Library & Upload ({assets.data?.length ?? 0})
          </button>
        </div>
      )}

      {candidate && onSelect && (
        <section className="rounded-xl border border-blue/40 bg-blue/5 p-3" aria-label="Review replacement image">
          <h3 className="text-sm font-semibold text-ink">Selected Image Preview</h3>
          <div className="my-3 grid grid-cols-2 gap-2">
            {["Desktop", "Phone"].map((device) => (
              <figure key={device} className="rounded-lg border border-line bg-white p-2">
                <figcaption className="text-[11px] font-medium text-muted">{device}</figcaption>
                <img
                  src={candidate.preview}
                  alt={candidate.alt}
                  onError={() => setPreviewFailed(true)}
                  className={`mx-auto mt-1 h-28 object-contain ${device === "Phone" ? "w-3/4" : "w-full"}`}
                />
              </figure>
            ))}
          </div>
          <label className="block text-xs font-medium text-ink">
            Alt text / description
            <input
              maxLength={500}
              className="my-1.5 w-full rounded-[10px] border border-line bg-white p-2 text-xs"
              value={candidate.alt}
              onChange={(e) => setCandidate({ ...candidate, alt: e.target.value })}
            />
          </label>
          {previewFailed && (
            <p role="alert" className="mb-2 text-xs text-danger-text">
              Image preview failed to load from remote URL, but you can still insert the link.
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                onSelect({ url: candidate.url, alt: candidate.alt, preview: candidate.preview });
                setCandidate(null);
              }}
            >
              Insert Media
            </Button>
            <button
              type="button"
              className="rounded-lg px-3 py-1 text-xs font-medium text-muted hover:bg-white hover:text-ink"
              onClick={() => setCandidate(null)}
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {activeTab === "page" && capturedImages.length > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted">
              Images & CSS background images automatically captured from this HTML page:
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            {capturedImages.map((img, idx) => {
              const name = img.alt || img.url.split("/").pop()?.split("?")[0] || `Image ${idx + 1}`;
              return (
                <div
                  key={`${img.url}-${idx}`}
                  className="group flex flex-col overflow-hidden rounded-xl border border-line bg-white transition hover:border-blue hover:shadow-sm"
                >
                  <button
                    type="button"
                    disabled={!onSelect}
                    onClick={() => {
                      if (onSelect) {
                        onSelect({ url: img.url, alt: img.alt, preview: img.preview });
                      }
                    }}
                    className="relative h-28 w-full overflow-hidden bg-sunken text-left"
                    title={`Click to select ${name}`}
                  >
                    <img
                      src={img.preview ?? img.url}
                      alt={img.alt}
                      className="h-full w-full object-cover transition duration-200 group-hover:scale-105"
                    />
                    {img.source && (
                      <span className="absolute left-1.5 top-1.5 rounded bg-ink/75 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white">
                        {img.source}
                      </span>
                    )}
                    <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/80 via-ink/40 to-transparent px-2 py-1.5 text-center text-[11px] font-semibold text-white opacity-0 transition group-hover:opacity-100">
                      Use Image
                    </span>
                  </button>
                  <div className="flex items-center justify-between gap-1 border-t border-line px-2 py-1.5">
                    <span className="truncate text-[11px] font-medium text-ink" title={img.url}>
                      {name}
                    </span>
                    {access.data?.capabilities.edit && (
                      <button
                        type="button"
                        disabled={savingUrl === img.url}
                        onClick={() => void saveCapturedToLibrary(img)}
                        className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] font-medium text-muted hover:border-blue hover:text-blue"
                        title="Save a copy into the persistent Site Library"
                      >
                        {savingUrl === img.url ? "…" : "Save"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {access.data?.capabilities.edit && (
            <div className="space-y-3 rounded-xl border border-line bg-sunken p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-ink">
                  Upload to Media Library ({tierStatus?.tierName ?? "Starter"} • Max {maxUploadLabel} per file)
                </span>
                {tierStatus && (
                  <span className="font-mono text-[11px] text-muted">
                    Storage remaining: <strong className="text-ink">{tierStatus.storage.remainingFormatted}</strong> of{" "}
                    {tierStatus.storage.quotaFormatted}
                  </span>
                )}
              </div>
              <label className="block text-xs text-muted">
                PNG, JPEG, WebP, GIF or SVG · up to {maxUploadLabel}
                <input
                  className="mt-2 block w-full text-xs"
                  key={uploadKey}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.svg"
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    upload.reset();
                  }}
                />
              </label>
              <label className="block text-xs text-muted">
                Image description
                <input
                  className="mt-1 h-9 w-full rounded-xl border border-line bg-white px-2 text-xs text-ink"
                  value={alt}
                  onChange={(e) => setAlt(e.target.value)}
                  placeholder="Describe what the image shows"
                />
              </label>
              <Button size="sm" disabled={!file || upload.isPending} onClick={() => upload.mutate()}>
                {upload.isPending ? "Uploading…" : onSelect ? "Upload & preview" : "Upload image"}
              </Button>
              {upload.error && (
                <p role="alert" className="text-xs text-danger-text">
                  {(upload.error as Error).message}
                </p>
              )}
              <p className="text-[11px] leading-relaxed text-muted">
                Images go live with the page when you publish. HTML downloads include uploaded images.
              </p>
            </div>
          )}
          {assets.isLoading && <p className="text-xs text-muted">Loading images…</p>}
          {assets.error && (
            <p role="alert" className="text-xs text-danger-text">
              {(assets.error as Error).message}
            </p>
          )}
          {/* A refused delete names the pages still using the picture; unshown,
              the click simply did nothing. */}
          {deleteAsset.error && (
            <p role="alert" className="text-xs text-danger-text">
              {(deleteAsset.error as Error).message}
            </p>
          )}
          <div className="grid grid-cols-3 gap-2.5">
            {assets.data?.map((asset) => (
              <div
                key={asset.id}
                className="group flex flex-col overflow-hidden rounded-xl border border-line bg-white text-left transition hover:border-blue hover:shadow-sm"
              >
                <button
                  type="button"
                  disabled={!onSelect || isPlayable(asset)}
                  onClick={() => {
                    if (onSelect && !isPlayable(asset)) {
                      onSelect({ url: asset.url, alt: asset.alt, preview: asset.preview });
                    }
                  }}
                  className="relative h-28 w-full overflow-hidden bg-sunken text-left"
                  title={isVideo(asset) ? `${asset.filename} is a video: it plays from a video's own settings` : isAudio(asset) ? `${asset.filename} is audio: it plays from an audio player's own settings` : `Use ${asset.filename}`}
                >
                  {isVideo(asset) ? (
                    <video src={asset.preview} muted playsInline preload="metadata" aria-label={asset.filename} className="h-full w-full object-contain" />
                  ) : isAudio(asset) ? (
                    <AudioTile asset={asset} controls={false} />
                  ) : (
                    <img
                      src={asset.preview}
                      alt={asset.alt}
                      className="h-full w-full object-contain transition duration-200 group-hover:scale-105"
                    />
                  )}
                  {onSelect && !isPlayable(asset) && (
                    <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/80 via-ink/40 to-transparent px-2 py-1.5 text-center text-[11px] font-semibold text-white opacity-0 transition group-hover:opacity-100">
                      Use Image
                    </span>
                  )}
                </button>
                <div className="flex items-center justify-between gap-1 border-t border-line px-2 py-1.5">
                  <span className="truncate text-[11px] font-medium text-ink" title={asset.filename}>
                    {asset.filename}
                  </span>
                  {access.data?.capabilities.edit && (
                    <button
                      type="button"
                      onClick={() => deleteAsset.mutate(asset.id)}
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted hover:bg-danger/10 hover:text-danger-text"
                      title="Delete from Media Library and free storage"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {assets.data?.length === 0 && <p className="text-xs text-muted">Upload your first image to this website.</p>}
        </div>
      )}
    </div>
  );
}

export function WebsiteAssets() {
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const sites = useQuery({ queryKey: ["website", "sites"], queryFn: ({ signal }) => api.get<SiteSummary[]>("/website/sites", signal) });
  // Paged on the server (for staff it is every customer's library), so the
  // pages are joined here and the filters below run over what has arrived.
  const allAssets = useInfiniteQuery({
    queryKey: ["website", "assets", "all"], initialPageParam: "",
    queryFn: ({ pageParam, signal }) => api.page<Asset & { siteId: string; siteName: string; size: number }>(`/website/assets?limit=100${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const loaded = allAssets.data?.pages.flatMap((page) => page.items);
  const more = allAssets.hasNextPage;
  const shown = loaded?.filter((asset) =>
    (!selected || asset.siteId === selected) &&
    `${asset.filename} ${asset.alt} ${asset.siteName}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <div className="space-y-5">
      <PageHeader title="Assets" subtitle="All images uploaded to websites you can access." />
      <div className="flex flex-wrap gap-3">
        <select aria-label="Filter by website" value={selected} onChange={(e) => setSelected(e.target.value)} className="h-10 rounded-xl border border-line bg-white px-3 text-sm">
          <option value="">All websites</option>
          {sites.data?.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
        </select>
        <input aria-label="Search assets" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search images" className="h-10 rounded-xl border border-line bg-white px-3 text-sm" />
      </div>
      {allAssets.isLoading && <p className="text-sm text-muted">Loading assets…</p>}
      {allAssets.error && <p role="alert" className="text-sm text-danger-text">{(allAssets.error as Error).message}</p>}
      {shown && <p className="text-xs text-muted">{shown.length} {shown.length === 1 ? "image" : "images"}{more ? " so far" : ""}</p>}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {shown?.map((asset) => <article key={asset.id} className="overflow-hidden rounded-xl border border-line bg-white">
          {isVideo(asset)
            ? <video src={asset.preview} muted playsInline controls preload="metadata" aria-label={asset.filename} className="h-36 w-full bg-sunken object-contain" />
            : isAudio(asset)
              ? <div className="h-36 w-full bg-sunken"><AudioTile asset={asset} controls /></div>
              : <img src={asset.preview} alt={asset.alt || asset.filename} loading="lazy" className="h-36 w-full bg-sunken object-contain" />}
          <div className="space-y-1 p-3 text-xs">
            <p className="truncate font-semibold text-ink" title={asset.filename}>{asset.filename}</p>
            <p className="truncate text-muted">{asset.siteName}</p>
            <p className="text-muted">{(asset.size / 1024).toFixed(0)} KB</p>
          </div>
        </article>)}
      </div>
      {shown?.length === 0 && <p className="text-sm text-muted">{search || selected ? (more ? "None of the images loaded so far match these filters." : "No images match these filters.") : "No uploaded images yet. Select a website below to upload one."}</p>}
      {more && (
        <button type="button" className="text-sm underline" disabled={allAssets.isFetchingNextPage} onClick={() => void allAssets.fetchNextPage()}>
          {allAssets.isFetchingNextPage ? "Loading images…" : "Load more images"}
        </button>
      )}
      {sites.data?.length ? <div className="max-w-3xl border-t border-line pt-5">
        <h2 className="mb-3 text-sm font-semibold text-ink">Upload and manage website images</h2>
        <select aria-label="Website for upload" value={selected || sites.data[0].id} onChange={(e) => setSelected(e.target.value)} className="mb-4 h-10 rounded-xl border border-line bg-white px-3 text-sm">
          {sites.data.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
        </select>
        <WebsiteAssetLibrary key={selected || sites.data[0].id} siteId={selected || sites.data[0].id} />
      </div> : <p className="text-sm text-muted">Connect a website to upload images.</p>}
    </div>
  );
}

export function WebsiteAssetPickerModal({
  siteId,
  capturedImages = [],
  onSelect,
  onClose,
}: {
  siteId: string;
  capturedImages?: CapturedHtmlImage[];
  onSelect: (asset: WebsiteAssetSelection) => void;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="asset-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border border-line bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 id="asset-modal-title" className="font-display text-base font-semibold text-ink">
              Media Library
            </h2>
            <p className="text-xs text-muted">
              Select an image captured from your HTML page, pick from site assets, or upload a new image
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-[10px] text-muted hover:bg-sunken hover:text-ink"
            aria-label="Close"
          >
            <IconXCircle size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <WebsiteAssetLibrary siteId={siteId} capturedImages={capturedImages} onSelect={onSelect} />
        </div>
      </div>
    </div>
  );
}
