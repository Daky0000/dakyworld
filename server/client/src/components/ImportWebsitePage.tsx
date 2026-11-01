import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, fileToBase64 } from "../lib/api";
import { getFilesFromDataTransfer, zipFilesToBase64 } from "../lib/folderZip";
import { Button } from "./ui";
import { WebsiteTierStatusBanner, notifyTierStatusChanged, useWebsiteTierStatus } from "./WebsiteTierStatusBanner";

type PackageImportResult = {
  pages: Array<{ id: string; title: string; path: string; filePath: string }>;
  assetsCount: number;
  missingAssets: string[];
  externalResources: string[];
  warnings: string[];
};

export function ImportWebsitePage({ siteId }: { siteId: string }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [isZip, setIsZip] = useState(false);
  const [folderPackage, setFolderPackage] = useState<{ filename: string; data: string; count: number } | null>(null);
  const [isPackaging, setIsPackaging] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [title, setTitle] = useState("");
  const [path, setPath] = useState("/new-page");
  const [filePath, setFilePath] = useState("new-page.html");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { status: tierStatus } = useWebsiteTierStatus(siteId);
  const importsExhausted =
    tierStatus?.usage.importsLimit != null && tierStatus.usage.importsUsed >= tierStatus.usage.importsLimit;

  const upload = useMutation({
    mutationFn: async () => {
      if (folderPackage) {
        const result = await api.post<PackageImportResult>(`/website/sites/${siteId}/import-package`, {
          filename: folderPackage.filename,
          data: folderPackage.data,
        });
        if (!result.pages.length) throw new Error("No HTML pages found in package archive.");
        return { id: result.pages[0].id, packageResult: result };
      }

      if (!file) throw new Error("Choose an HTML file, ZIP package, or project folder.");
      if (isZip) {
        if (file.size > 1024 * 1024 * 1024) throw new Error("Choose a ZIP package smaller than 1 GB.");
        const data = await fileToBase64(file);
        const result = await api.post<PackageImportResult>(`/website/sites/${siteId}/import-package`, {
          filename: file.name,
          data,
        });
        if (!result.pages.length) throw new Error("No HTML pages found in package archive.");
        return { id: result.pages[0].id, packageResult: result };
      }

      if (file.size > 1024 * 1024 * 1024) throw new Error("Choose an HTML file smaller than 1 GB.");
      const result = await api.post<{ id: string }>(`/website/sites/${siteId}/import`, {
        title: title.trim(),
        path: path.trim(),
        filePath: filePath.trim(),
        html: await file.text(),
      });
      return { id: result.id };
    },
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: ["website"] });
      notifyTierStatusChanged();
      navigate(`/website/pages/${result.id}`);
    },
  });

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Import a page
        {tierStatus?.usage.importsLimit != null
          ? ` (${tierStatus.usage.importsUsed}/${tierStatus.usage.importsLimit})`
          : ""}
      </Button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="import-page-title"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !upload.isPending) setOpen(false);
          }}
        >
          <form
            className="w-full max-w-xl space-y-4 rounded-2xl bg-white p-6 shadow-xl"
            onSubmit={(event) => {
              event.preventDefault();
              if (!upload.isPending && !importsExhausted) upload.mutate();
            }}
          >
            <h2 id="import-page-title" className="font-display text-xl">
              {isZip ? "Import a website ZIP package" : "Import an HTML page"}
            </h2>
            <p className="text-sm text-muted">
              {isZip
                ? "Upload a ZIP archive containing HTML pages, CSS styles, images, and fonts. Relative asset links are linked automatically."
                : "Add an existing page to this website. All embedded images are automatically captured into your Media Library storage."}
            </p>
            <WebsiteTierStatusBanner siteId={siteId} compact />
            {importsExhausted && tierStatus && (
              <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-xs text-danger-text">
                Monthly HTML import limit reached ({tierStatus.usage.importsUsed}/{tierStatus.usage.importsLimit} imports on{" "}
                {tierStatus.tierName} {tierStatus.pricing.priceDisplay}/mo). Upgrade your tier plan or switch test user above to continue importing.
              </p>
            )}
            <div
              className={`rounded-xl border border-dashed p-4 text-xs transition-colors ${
                isDragging
                  ? "border-primary bg-primary/5"
                  : "border-line-strong bg-sunken"
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={async (e) => {
                e.preventDefault();
                setIsDragging(false);
                setFile(null);
                setFolderPackage(null);
                setIsZip(false);
                upload.reset();

                try {
                  const items = e.dataTransfer.items;
                  if (!items || items.length === 0) return;

                  if (items.length === 1 && !items[0].webkitGetAsEntry()?.isDirectory) {
                    const droppedFile = items[0].getAsFile();
                    if (!droppedFile) return;
                    setFile(droppedFile);
                    const zipMode = droppedFile.name.toLowerCase().endsWith(".zip") || droppedFile.type === "application/zip";
                    setIsZip(zipMode);
                    if (!zipMode) {
                      const slug = droppedFile.name.replace(/\.html?$/i, "").replace(/[^a-zA-Z0-9_-]/g, "-") || "new-page";
                      setTitle(slug.replace(/[-_]/g, " "));
                      setFilePath(`${slug}.html`);
                      setPath(slug === "index" ? "/" : `/${slug}`);
                    }
                    return;
                  }

                  setIsPackaging(true);
                  const extracted = await getFilesFromDataTransfer(items);
                  if (extracted.length === 0) {
                    setIsPackaging(false);
                    return;
                  }

                  const folderName = items[0].webkitGetAsEntry()?.name || "package";
                  const zipped = await zipFilesToBase64(extracted, `${folderName}.zip`);
                  setFolderPackage({ filename: zipped.filename, data: zipped.base64, count: zipped.fileCount });
                  setIsZip(true);
                } catch {
                } finally {
                  setIsPackaging(false);
                }
              }}
            >
              <span className="block font-medium text-ink">
                HTML file, ZIP package, or project folder
              </span>
              <span className="mt-0.5 block text-muted">
                Drop your ZIP package or project folder here, or choose an option:
              </span>
              <div className="mt-2 flex flex-wrap gap-2">
                <label className="cursor-pointer rounded-lg border border-line bg-surface px-3 py-1.5 font-medium text-ink shadow-sm hover:bg-surface-hover">
                  Choose file or ZIP
                  <input
                    disabled={upload.isPending || importsExhausted}
                    type="file"
                    accept=".html,.htm,.zip,application/zip,text/html"
                    className="hidden"
                    onChange={(event) => {
                      const selected = event.target.files?.[0] ?? null;
                      setFile(selected);
                      setFolderPackage(null);
                      upload.reset();
                      if (selected) {
                        const zipMode = selected.name.toLowerCase().endsWith(".zip") || selected.type === "application/zip";
                        setIsZip(zipMode);
                        if (!zipMode) {
                          const slug = selected.name.replace(/\.html?$/i, "").replace(/[^a-zA-Z0-9_-]/g, "-") || "new-page";
                          setTitle(slug.replace(/[-_]/g, " "));
                          setFilePath(`${slug}.html`);
                          setPath(slug === "index" ? "/" : `/${slug}`);
                        }
                      } else {
                        setIsZip(false);
                      }
                    }}
                  />
                </label>

                <label className="cursor-pointer rounded-lg border border-line bg-surface px-3 py-1.5 font-medium text-ink shadow-sm hover:bg-surface-hover">
                  Choose project folder
                  <input
                    disabled={upload.isPending || importsExhausted}
                    type="file"
                    {...({ webkitdirectory: "", directory: "", multiple: true } as any)}
                    className="hidden"
                    onChange={async (event) => {
                      const files = event.target.files;
                      setFile(null);
                      setFolderPackage(null);
                      upload.reset();
                      if (!files || files.length === 0) return;

                      setIsPackaging(true);
                      try {
                        const fileEntries = Array.from(files).map((f) => ({
                          file: f,
                          path: f.webkitRelativePath || f.name,
                        }));
                        const firstPart = fileEntries[0]?.path.split("/")[0] || "package";
                        const zipped = await zipFilesToBase64(fileEntries, `${firstPart}.zip`);
                        setFolderPackage({ filename: zipped.filename, data: zipped.base64, count: zipped.fileCount });
                        setIsZip(true);
                      } catch {
                      } finally {
                        setIsPackaging(false);
                      }
                    }}
                  />
                </label>

                {(file || folderPackage) && (
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 text-muted hover:text-ink"
                    onClick={() => {
                      setFile(null);
                      setFolderPackage(null);
                      setIsZip(false);
                      upload.reset();
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>

              {isPackaging && (
                <span className="mt-2 block text-primary animate-pulse">
                  Packaging folder into archive…
                </span>
              )}

              {(file || folderPackage) && !isPackaging && (
                <span className="mt-2 block font-medium text-emerald-600">
                  ✓ {folderPackage
                    ? `Folder package ${folderPackage.filename} (${folderPackage.count} files) ready to import.`
                    : `${file?.name} ready to import.`}
                </span>
              )}
            </div>

            {isZip || folderPackage ? (
              <div className="rounded-xl border border-line bg-sunken/60 p-4 text-xs text-muted space-y-1.5">
                <p className="font-semibold text-ink">Package Import Detected</p>
                <p>
                  Pages and relative assets (CSS, JS, fonts, images) will be automatically discovered and imported as a site operation.
                </p>
                <p>Page URLs and routes will be mapped from the archive file structure (e.g. index.html or home.html → /).</p>
              </div>
            ) : (
              ([
                ["Title", title, setTitle],
                ["Page address", path, setPath],
                ["Repository file", filePath, setFilePath],
              ] as const).map(([label, value, setValue]) => (
                <label key={label} className="block text-xs text-muted">
                  {label}
                  <input
                    required
                    disabled={upload.isPending || importsExhausted}
                    maxLength={label === "Title" ? 120 : 200}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    className="mt-1 w-full rounded-xl border border-line px-3 py-2 text-sm text-ink"
                  />
                </label>
              ))
            )}

            {!isZip && (
              <p className="text-xs text-muted">
                Use a new page address and file name. An existing page is never replaced by an import.
              </p>
            )}
            {upload.error && (
              <p role="alert" className="text-sm text-danger-text">
                {(upload.error as Error).message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={upload.isPending} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!file || upload.isPending || importsExhausted}>
                {upload.isPending ? "Importing…" : isZip ? "Import package & edit" : "Import & edit"}
              </Button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

