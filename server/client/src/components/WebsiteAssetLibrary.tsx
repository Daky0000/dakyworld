import { useEffect, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { SiteSummary } from "../lib/types";
import { Button, PageHeader } from "./ui";
import { useWebsiteAccess } from "./WebsiteMembers";
import { WebsiteTierStatusBanner, notifyTierStatusChanged, useWebsiteTierStatus } from "./WebsiteTierStatusBanner";
import { IconCheck, IconExternalLink, IconEye, IconImage, IconUploadCloud, IconXCircle } from "./WebsiteIcons";

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

export type ReplaceTarget = {
  url: string;
  preview?: string;
  alt?: string;
  source?: string;
  assetId?: string;
  filename?: string;
};

export type PreviewMediaItem = {
  url: string;
  preview?: string;
  alt?: string;
  source?: string;
  assetId?: string;
  filename?: string;
  byteSize?: number;
};

export function SafeImage({
  src,
  fallbackSrc,
  alt,
  className,
}: {
  src: string;
  fallbackSrc?: string;
  alt?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [triedFallback, setTriedFallback] = useState(false);

  useEffect(() => {
    setFailed(false);
    setTriedFallback(false);
  }, [src, fallbackSrc]);

  if (failed) {
    return (
      <div className={`flex flex-col items-center justify-center bg-sunken/80 text-muted p-2 text-center select-none ${className || "h-full w-full"}`}>
        <IconImage size={24} className="mb-1 opacity-40" />
        <span className="line-clamp-2 text-[10px] leading-tight font-medium opacity-75">{alt || "Image preview unavailable"}</span>
      </div>
    );
  }

  const activeSrc = triedFallback && fallbackSrc ? fallbackSrc : src;

  return (
    <img
      src={activeSrc}
      alt={alt || ""}
      loading="lazy"
      className={className}
      onError={() => {
        if (!triedFallback && fallbackSrc && fallbackSrc !== src) {
          setTriedFallback(true);
        } else {
          setFailed(true);
        }
      }}
    />
  );
}

export function WebsiteMediaPreviewModal({
  item,
  siteId,
  onClose,
  onReplace,
  onSelect,
}: {
  item: PreviewMediaItem;
  siteId: string;
  onClose: () => void;
  onReplace?: () => void;
  onSelect?: (selection: WebsiteAssetSelection) => void;
}) {
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const displayTitle = item.filename || item.alt || item.url.split("/").pop()?.split("?")[0] || "Image Preview";
  const cleanUrlPath = item.url.replace(/^\/+/, "").replace(/\?.*$/, "");
  const rawFallback = `/api/website/sites/${siteId}/raw/${cleanUrlPath}`;
  const primarySrc = item.preview || item.url;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image Preview"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/75 p-4 backdrop-blur-xs transition-opacity"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col rounded-2xl border border-line bg-white shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5 bg-white">
          <div className="min-w-0 pr-4">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-display text-base font-semibold text-ink" title={displayTitle}>
                {displayTitle}
              </h2>
              {item.source && (
                <span className="shrink-0 rounded bg-sunken px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted border border-line">
                  {item.source}
                </span>
              )}
            </div>
            <p className="truncate text-xs font-mono text-muted mt-0.5" title={item.url}>
              {item.url}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-muted hover:bg-sunken hover:text-ink transition"
            aria-label="Close"
          >
            <IconXCircle size={20} />
          </button>
        </div>

        {/* Image Display */}
        <div className="relative flex min-h-[300px] max-h-[64vh] flex-1 items-center justify-center bg-sunken/40 p-4 overflow-auto">
          <img
            src={primarySrc}
            alt={item.alt || displayTitle}
            onLoad={(e) => {
              const target = e.currentTarget;
              setDimensions({ width: target.naturalWidth, height: target.naturalHeight });
            }}
            onError={(e) => {
              if (e.currentTarget.src !== rawFallback && !item.url.startsWith("http")) {
                e.currentTarget.src = rawFallback;
              }
            }}
            className="max-h-[60vh] max-w-full rounded-lg object-contain shadow-md"
          />
        </div>

        {/* Footer info & actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3.5 bg-white">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            {dimensions && (
              <span>
                Dimensions: <strong className="text-ink">{dimensions.width} × {dimensions.height} px</strong>
              </span>
            )}
            {item.alt && (
              <span className="truncate max-w-xs" title={item.alt}>
                Alt: <span className="text-ink">"{item.alt}"</span>
              </span>
            )}
            {typeof item.byteSize === "number" && (
              <span>
                Size: <strong className="text-ink">{(item.byteSize / 1024).toFixed(0)} KB</strong>
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <a
              href={primarySrc}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-muted hover:bg-sunken hover:text-ink transition"
            >
              <IconExternalLink size={13} />
              Open Original
            </a>
            {onSelect && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  onSelect({ url: item.url, alt: item.alt || displayTitle, preview: item.preview });
                  onClose();
                }}
              >
                Use Image
              </Button>
            )}
            {onReplace && (
              <Button
                size="sm"
                onClick={() => {
                  onClose();
                  onReplace();
                }}
              >
                Replace Image
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function WebsiteMediaReplaceModal({
  siteId,
  target,
  onClose,
  onReplace,
  existingAssets = [],
}: {
  siteId: string;
  target: ReplaceTarget;
  onClose: () => void;
  onReplace: (replacement: WebsiteAssetSelection) => Promise<void> | void;
  existingAssets?: Asset[];
}) {
  const { status: tierStatus } = useWebsiteTierStatus(siteId);
  const [tab, setTab] = useState<"upload" | "library">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [alt, setAlt] = useState(target.alt || target.filename || "");
  const [selectedLibraryAsset, setSelectedLibraryAsset] = useState<Asset | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const maxUploadBytes = tierStatus?.storage.maxSingleAssetBytes ?? 5_000_000;
  const maxUploadLabel = tierStatus?.storage.maxSingleAssetFormatted ?? "5 MB";

  const handleFileChange = (selectedFile: File | null) => {
    setError(null);
    setFile(selectedFile);
    if (selectedFile) {
      if (selectedFile.size > maxUploadBytes) {
        setError(`File size (${(selectedFile.size / (1024 * 1024)).toFixed(2)} MB) exceeds ${maxUploadLabel}.`);
        setFile(null);
        setFilePreview(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => setFilePreview(String(reader.result));
      reader.readAsDataURL(selectedFile);
      if (!alt) {
        setAlt(selectedFile.name.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " "));
      }
    } else {
      setFilePreview(null);
    }
  };

  const executeReplace = async () => {
    setError(null);
    setIsSubmitting(true);
    try {
      if (tab === "upload") {
        if (!file) throw new Error("Please select an image file to upload.");
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

        if (target.assetId) {
          const res = await api.put<{ id: string; url: string; alt: string; preview: string }>(
            `/website/sites/${siteId}/assets/${target.assetId}`,
            { filename: file.name, alt, data }
          );
          await qc.invalidateQueries({ queryKey: ["website", "assets", siteId] });
          await qc.invalidateQueries({ queryKey: ["website", "assets", "all"] });
          notifyTierStatusChanged();
          await onReplace({ url: res.url, alt: res.alt || alt, preview: res.preview });
        } else {
          const res = await api.post<{ id: string; url: string; alt: string }>(
            `/website/sites/${siteId}/assets`,
            { filename: file.name, alt, data }
          );
          await qc.invalidateQueries({ queryKey: ["website", "assets", siteId] });
          await qc.invalidateQueries({ queryKey: ["website", "assets", "all"] });
          notifyTierStatusChanged();
          await onReplace({
            url: res.url,
            alt: res.alt || alt,
            preview: `/api/website/sites/${siteId}/assets/${res.id}/content?v=${Date.now()}`,
          });
        }
      } else {
        if (!selectedLibraryAsset) throw new Error("Please select an image from the library.");
        if (target.assetId && target.assetId !== selectedLibraryAsset.id) {
          const contentRes = await fetch(selectedLibraryAsset.preview);
          const blob = await contentRes.blob();
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = () => reject(new Error("Could not read asset blob."));
            reader.readAsDataURL(blob);
          });
          const res = await api.put<{ id: string; url: string; alt: string; preview: string }>(
            `/website/sites/${siteId}/assets/${target.assetId}`,
            { filename: selectedLibraryAsset.filename, alt: selectedLibraryAsset.alt, data }
          );
          await qc.invalidateQueries({ queryKey: ["website", "assets", siteId] });
          await qc.invalidateQueries({ queryKey: ["website", "assets", "all"] });
          notifyTierStatusChanged();
          await onReplace({ url: res.url, alt: res.alt, preview: res.preview });
        } else {
          await onReplace({
            url: selectedLibraryAsset.url,
            alt: selectedLibraryAsset.alt,
            preview: selectedLibraryAsset.preview,
          });
        }
      }
      onClose();
    } catch (err) {
      setError((err as Error).message || "Replacement failed.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="replace-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-line bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 id="replace-modal-title" className="font-display text-base font-semibold text-ink">
              Replace Image
            </h2>
            <p className="text-xs text-muted">
              {target.assetId
                ? "Replaces this asset across your website library and anywhere it is referenced."
                : "Replaces this image across the page (including parallax animations and backgrounds) without having to find or click the element on the canvas."}
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

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <div className="flex items-center gap-3 rounded-xl border border-line bg-sunken p-3">
            <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-line bg-white">
              <SafeImage
                src={target.preview || target.url}
                fallbackSrc={`/api/website/sites/${siteId}/raw/${target.url.replace(/^\/+/, "").replace(/\?.*$/, "")}`}
                alt={target.alt || "Current image"}
                className="h-full w-full object-cover"
              />
            </div>
            <div className="min-w-0 flex-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                Current Image {target.source ? `• ${target.source}` : ""}
              </span>
              <p className="truncate text-xs font-semibold text-ink" title={target.url}>
                {target.filename || target.alt || target.url.split("/").pop() || "Image"}
              </p>
              <p className="truncate text-[10px] text-muted" title={target.url}>
                {target.url}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 rounded-xl border border-line bg-sunken p-1">
            <button
              type="button"
              onClick={() => { setTab("upload"); setError(null); }}
              className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                tab === "upload" ? "bg-white text-ink shadow-xs" : "text-muted hover:text-ink"
              }`}
            >
              Upload New File
            </button>
            <button
              type="button"
              onClick={() => { setTab("library"); setError(null); }}
              className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                tab === "library" ? "bg-white text-ink shadow-xs" : "text-muted hover:text-ink"
              }`}
            >
              Choose from Site Library ({existingAssets.length})
            </button>
          </div>

          {tab === "upload" ? (
            <div className="space-y-3">
              <label className="block rounded-xl border-2 border-dashed border-line bg-sunken/50 p-4 text-center cursor-pointer hover:border-blue hover:bg-blue/5 transition">
                <input
                  type="file"
                  className="hidden"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.svg"
                  onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
                />
                {filePreview ? (
                  <div className="space-y-2">
                    <img src={filePreview} alt="Selected preview" className="mx-auto h-28 max-w-full rounded-lg object-contain shadow-xs" />
                    <p className="text-xs font-medium text-ink">{file?.name} ({(file?.size ? file.size / 1024 : 0).toFixed(0)} KB)</p>
                    <span className="inline-block text-[11px] text-blue font-semibold">Click to choose another file</span>
                  </div>
                ) : (
                  <div className="space-y-1.5 py-2">
                    <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-blue/10 text-blue">
                      <IconUploadCloud size={20} />
                    </div>
                    <p className="text-xs font-medium text-ink">Choose a new file to replace this image</p>
                    <p className="text-[11px] text-muted">PNG, JPEG, WebP, GIF or SVG up to {maxUploadLabel}</p>
                  </div>
                )}
              </label>

              <label className="block text-xs font-medium text-ink">
                Alt text / Description
                <input
                  className="mt-1 h-9 w-full rounded-xl border border-line bg-white px-3 text-xs text-ink"
                  value={alt}
                  onChange={(e) => setAlt(e.target.value)}
                  placeholder="Describe what the replacement image shows"
                />
              </label>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted">Select an existing image from your site library to replace this one:</p>
              <div className="grid max-h-56 grid-cols-3 gap-2 overflow-y-auto rounded-xl border border-line p-2">
                {existingAssets.map((asset) => (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => setSelectedLibraryAsset(asset)}
                    className={`group relative flex flex-col overflow-hidden rounded-lg border text-left transition ${
                      selectedLibraryAsset?.id === asset.id ? "border-blue ring-2 ring-blue/20 bg-blue/5" : "border-line bg-white hover:border-blue/50"
                    }`}
                  >
                    <div className="h-20 w-full bg-sunken overflow-hidden">
                      <SafeImage src={asset.preview} alt={asset.alt} className="h-full w-full object-cover" />
                    </div>
                    <div className="p-1.5">
                      <p className="truncate text-[10px] font-medium text-ink" title={asset.filename}>{asset.filename}</p>
                    </div>
                    {selectedLibraryAsset?.id === asset.id && (
                      <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-blue text-white">
                        <IconCheck size={10} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
              {existingAssets.length === 0 && (
                <p className="py-4 text-center text-xs text-muted">No images in your site library yet. Use the Upload tab to add one.</p>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="text-xs text-danger-text">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-line px-4 py-2 text-xs font-semibold text-muted hover:bg-sunken hover:text-ink transition"
          >
            Cancel
          </button>
          <Button
            size="sm"
            disabled={isSubmitting || (tab === "upload" ? !file : !selectedLibraryAsset)}
            onClick={() => void executeReplace()}
          >
            {isSubmitting ? "Replacing…" : "Replace Image"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function WebsiteAssetLibrary({
  siteId,
  onSelect,
  capturedImages = [],
  onReplacePageImage,
}: {
  siteId: string;
  onSelect?: (asset: WebsiteAssetSelection) => void;
  capturedImages?: CapturedHtmlImage[];
  onReplacePageImage?: (
    target: { url: string; preview?: string; alt?: string; source?: string },
    replacement: WebsiteAssetSelection,
  ) => Promise<void> | void;
}) {
  const access = useWebsiteAccess(siteId);
  const { status: tierStatus } = useWebsiteTierStatus(siteId);
  const [activeTab, setActiveTab] = useState<"page" | "library">(capturedImages.length > 0 ? "page" : "library");
  const [candidate, setCandidate] = useState<{ url: string; alt: string; preview: string } | null>(null);
  const [replacingTarget, setReplacingTarget] = useState<CapturedHtmlImage | null>(null);
  const [replacingAsset, setReplacingAsset] = useState<Asset | null>(null);
  const [previewingMedia, setPreviewingMedia] = useState<PreviewMediaItem | null>(null);
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
          <div className="grid grid-cols-2 gap-3">
            {capturedImages.map((img, idx) => {
              const name = img.alt || img.url.split("/").pop()?.split("?")[0] || `Image ${idx + 1}`;
              const cleanUrlPath = img.url.replace(/^\/+/, "").replace(/\?.*$/, "");
              const rawFallback = `/api/website/sites/${siteId}/raw/${cleanUrlPath}`;
              const primarySrc = img.preview || img.url;

              return (
                <div
                  key={`${img.url}-${idx}`}
                  className="group flex flex-col overflow-hidden rounded-xl border border-line bg-white transition hover:border-blue hover:shadow-sm"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setPreviewingMedia({
                        url: img.url,
                        preview: primarySrc,
                        alt: img.alt,
                        source: img.source,
                        filename: name,
                      });
                    }}
                    className="relative h-32 w-full overflow-hidden bg-sunken text-left cursor-pointer"
                    title={`Click to preview ${name}`}
                  >
                    <SafeImage
                      src={primarySrc}
                      fallbackSrc={rawFallback}
                      alt={img.alt || name}
                      className="h-full w-full object-cover transition duration-200 group-hover:scale-105"
                    />
                    {img.source && (
                      <span className="absolute left-1.5 top-1.5 rounded bg-ink/75 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white">
                        {img.source}
                      </span>
                    )}
                    <span className="absolute inset-0 flex items-center justify-center bg-ink/35 opacity-0 transition group-hover:opacity-100">
                      <span className="flex items-center gap-1 rounded-full bg-white/95 px-2.5 py-1 text-xs font-semibold text-ink shadow-sm backdrop-blur-xs">
                        <IconEye size={13} />
                        Preview
                      </span>
                    </span>
                  </button>
                  <div className="flex flex-col gap-1.5 border-t border-line p-2">
                    <span className="truncate text-xs font-medium text-ink" title={img.url}>
                      {name}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {access.data?.capabilities.edit && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setReplacingTarget(img);
                          }}
                          className="flex-1 rounded-lg border border-line bg-white px-2 py-1 text-center text-xs font-semibold text-ink shadow-2xs hover:border-blue hover:text-blue transition"
                          title="Replace this image across the page (including parallax animations and backgrounds)"
                        >
                          Replace
                        </button>
                      )}
                      {access.data?.capabilities.edit && (
                        <button
                          type="button"
                          disabled={savingUrl === img.url}
                          onClick={(e) => {
                            e.stopPropagation();
                            void saveCapturedToLibrary(img);
                          }}
                          className="flex-1 rounded-lg border border-line bg-white px-2 py-1 text-center text-xs font-medium text-muted hover:border-blue hover:text-blue transition"
                          title="Save a copy into the persistent Site Library"
                        >
                          {savingUrl === img.url ? "Saving…" : "Save"}
                        </button>
                      )}
                    </div>
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
          <div className="grid grid-cols-2 gap-3">
            {assets.data?.map((asset) => (
              <div
                key={asset.id}
                className="group flex flex-col overflow-hidden rounded-xl border border-line bg-white text-left transition hover:border-blue hover:shadow-sm"
              >
                <button
                  type="button"
                  onClick={() => {
                    setPreviewingMedia({
                      url: asset.url,
                      preview: asset.preview,
                      alt: asset.alt,
                      filename: asset.filename,
                      assetId: asset.id,
                      source: "Site Asset",
                      byteSize: asset.byteSize,
                    });
                  }}
                  className="relative h-32 w-full overflow-hidden bg-sunken text-left cursor-pointer"
                  title={`Preview ${asset.filename}`}
                >
                  {isVideo(asset) ? (
                    <video src={asset.preview} muted playsInline preload="metadata" aria-label={asset.filename} className="h-full w-full object-contain" />
                  ) : (
                    <SafeImage
                      src={asset.preview}
                      fallbackSrc={`/api/website/sites/${siteId}/raw/${asset.filename}`}
                      alt={asset.alt || asset.filename}
                      className="h-full w-full object-contain transition duration-200 group-hover:scale-105"
                    />
                  )}
                  <span className="absolute inset-0 flex items-center justify-center bg-ink/35 opacity-0 transition group-hover:opacity-100">
                    <span className="flex items-center gap-1 rounded-full bg-white/95 px-2.5 py-1 text-xs font-semibold text-ink shadow-sm backdrop-blur-xs">
                      <IconEye size={13} />
                      Preview
                    </span>
                  </span>
                </button>
                <div className="flex flex-col gap-1.5 border-t border-line p-2">
                  <span className="truncate text-xs font-medium text-ink" title={asset.filename}>
                    {asset.filename}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {access.data?.capabilities.edit && !isVideo(asset) && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setReplacingAsset(asset);
                        }}
                        className="flex-1 rounded-lg border border-line bg-white px-2 py-1 text-center text-xs font-semibold text-ink shadow-2xs hover:border-blue hover:text-blue transition"
                        title="Replace this image file with a new upload"
                      >
                        Replace
                      </button>
                    )}
                    {access.data?.capabilities.edit && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteAsset.mutate(asset.id);
                        }}
                        className="flex-1 rounded-lg px-2 py-1 text-center text-xs font-medium text-muted hover:bg-danger/10 hover:text-danger-text transition"
                        title="Delete from Media Library and free storage"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {assets.data?.length === 0 && <p className="text-xs text-muted">Upload your first image to this website.</p>}
        </div>
      )}

      {previewingMedia && (
        <WebsiteMediaPreviewModal
          item={previewingMedia}
          siteId={siteId}
          onClose={() => setPreviewingMedia(null)}
          onSelect={onSelect}
          onReplace={
            access.data?.capabilities.edit
              ? () => {
                  if (previewingMedia.assetId) {
                    const matched = assets.data?.find((a) => a.id === previewingMedia.assetId);
                    if (matched) {
                      setReplacingAsset(matched);
                    } else {
                      setReplacingAsset({
                        id: previewingMedia.assetId,
                        url: previewingMedia.url,
                        preview: previewingMedia.preview || previewingMedia.url,
                        filename: previewingMedia.filename || "image",
                        alt: previewingMedia.alt || "",
                      });
                    }
                  } else {
                    setReplacingTarget({
                      url: previewingMedia.url,
                      preview: previewingMedia.preview,
                      alt: previewingMedia.alt || previewingMedia.filename || "",
                      source: previewingMedia.source,
                    });
                  }
                }
              : undefined
          }
        />
      )}

      {replacingTarget && (
        <WebsiteMediaReplaceModal
          siteId={siteId}
          target={replacingTarget}
          existingAssets={assets.data ?? []}
          onClose={() => setReplacingTarget(null)}
          onReplace={async (replacement) => {
            if (onReplacePageImage) {
              await onReplacePageImage(replacingTarget, replacement);
            }
          }}
        />
      )}

      {replacingAsset && (
        <WebsiteMediaReplaceModal
          siteId={siteId}
          target={{
            url: replacingAsset.url,
            preview: replacingAsset.preview,
            filename: replacingAsset.filename,
            alt: replacingAsset.alt,
            assetId: replacingAsset.id,
            source: "Site Asset",
          }}
          existingAssets={assets.data ?? []}
          onClose={() => setReplacingAsset(null)}
          onReplace={async (replacement) => {
            if (onReplacePageImage) {
              await onReplacePageImage(
                { url: replacingAsset.url, preview: replacingAsset.preview, alt: replacingAsset.alt },
                replacement
              );
            }
          }}
        />
      )}
    </div>
  );
}

export function WebsiteAssets() {
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [replacingAsset, setReplacingAsset] = useState<(Asset & { siteId: string }) | null>(null);
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
            : <SafeImage src={asset.preview} fallbackSrc={`/api/website/sites/${asset.siteId}/raw/${asset.filename}`} alt={asset.alt || asset.filename} className="h-36 w-full bg-sunken object-contain" />}
          <div className="space-y-1 p-3 text-xs">
            <p className="truncate font-semibold text-ink" title={asset.filename}>{asset.filename}</p>
            <p className="truncate text-muted">{asset.siteName}</p>
            <div className="flex items-center justify-between pt-1">
              <span className="text-muted">{(asset.size / 1024).toFixed(0)} KB</span>
              <button
                type="button"
                onClick={() => setReplacingAsset(asset)}
                className="rounded border border-line bg-white px-2 py-0.5 text-[11px] font-semibold text-ink shadow-2xs hover:border-blue hover:text-blue"
                title="Replace this image with a new upload"
              >
                Replace
              </button>
            </div>
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

      {replacingAsset && (
        <WebsiteMediaReplaceModal
          siteId={replacingAsset.siteId}
          target={{
            url: replacingAsset.url,
            preview: replacingAsset.preview,
            filename: replacingAsset.filename,
            alt: replacingAsset.alt,
            assetId: replacingAsset.id,
            source: "Site Asset",
          }}
          existingAssets={[]}
          onClose={() => setReplacingAsset(null)}
          onReplace={() => {}}
        />
      )}
    </div>
  );
}

export function WebsiteAssetPickerModal({
  siteId,
  capturedImages = [],
  onSelect,
  onClose,
  onReplacePageImage,
}: {
  siteId: string;
  capturedImages?: CapturedHtmlImage[];
  onSelect: (asset: WebsiteAssetSelection) => void;
  onClose: () => void;
  onReplacePageImage?: (
    target: { url: string; preview?: string; alt?: string; source?: string },
    replacement: WebsiteAssetSelection,
  ) => Promise<void> | void;
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
          <WebsiteAssetLibrary
            siteId={siteId}
            capturedImages={capturedImages}
            onSelect={onSelect}
            onReplacePageImage={onReplacePageImage}
          />
        </div>
      </div>
    </div>
  );
}
