import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, fileToBase64 } from "../lib/api";
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
      if (!file) throw new Error("Choose an HTML file or ZIP package.");
      if (isZip) {
        if (file.size > 25_000_000) throw new Error("Choose a ZIP package smaller than 25 MB.");
        const data = await fileToBase64(file);
        const result = await api.post<PackageImportResult>(`/website/sites/${siteId}/import-package`, {
          filename: file.name,
          data,
        });
        if (!result.pages.length) throw new Error("No HTML pages found in package archive.");
        return { id: result.pages[0].id, packageResult: result };
      }

      if (file.size > 15_000_000) throw new Error("Choose an HTML file smaller than 15 MB.");
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
            <label className="block text-xs text-muted">
              HTML file or ZIP package (.html, .htm, .zip)
              <input
                autoFocus
                disabled={upload.isPending || importsExhausted}
                required
                type="file"
                accept=".html,.htm,.zip,application/zip,text/html"
                className="mt-2 block w-full text-sm"
                onChange={(event) => {
                  const selected = event.target.files?.[0] ?? null;
                  setFile(selected);
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

            {isZip ? (
              <div className="rounded-xl border border-line bg-sunken/60 p-4 text-xs text-muted space-y-1.5">
                <p className="font-semibold text-ink">ZIP Archive Package Detected</p>
                <p>
                  Pages and relative assets (CSS, JS, fonts, images) will be automatically discovered and imported as a site operation.
                </p>
                <p>Page URLs and routes will be mapped from the archive file structure (e.g. index.html → /).</p>
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

