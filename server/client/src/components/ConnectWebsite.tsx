import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, fileToBase64 } from "../lib/api";
import { getFilesFromDataTransfer, zipFilesToBase64 } from "../lib/folderZip";
import { Button } from "./ui";
import { ConnectWordPress, WORDPRESS_GUIDE } from "./ConnectWordPress";

/**
 * Bringing a website in, by whichever of the three routes fits.
 *
 * The dialog used to ask for a repository and a branch and leave anybody
 * without a GitHub account to work out whether the product was for them. There
 * are two answers and they want different things: we host it and they point a
 * domain at us, or they already have a repository and we publish into it. So
 * the first screen is the choice, each route says what it will ask for before
 * it asks, and each links to its own half of the setup guide.
 *
 * And a way out of both: for a fixed fee somebody here does it instead. The
 * step where people give up is never the editing, it is this.
 */

type Assistance = {
  currency: string;
  amount: number;
  display: string;
  guides: { hosted: string; github: string; wordpress?: string };
};

/** A WordPress site is its own route: no repository and no hosting, its pages stay in WordPress. */
type Route = "hosted" | "github" | "wordpress";

const GUIDE = {
  hosted: "https://dakyx.com/website-builder-setup#hosted",
  github: "https://dakyx.com/website-builder-setup#github",
  wordpress: WORDPRESS_GUIDE,
};

export function ConnectWebsite() {
  const [open, setOpen] = useState(false);
  const [route, setRoute] = useState<Route | null>(null);
  const [name, setName] = useState("");
  const [publicUrl, setUrl] = useState("");
  const [repository, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [html, setHtml] = useState<string | undefined>();
  const [packageData, setPackageData] = useState<string | undefined>();
  const [packageFilename, setPackageFilename] = useState<string | undefined>();
  const [filename, setFilename] = useState("");
  const [templateKey, setTemplateKey] = useState("business");
  const [fileError, setFileError] = useState<string | null>(null);
  const [isPackaging, setIsPackaging] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [helpNotes, setHelpNotes] = useState("");
  const [helpAsked, setHelpAsked] = useState<string | null>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const assistance = useQuery({
    queryKey: ["website", "setup-assistance"],
    queryFn: ({ signal }) => api.get<Assistance>("/website/setup-assistance", signal),
    enabled: open,
    staleTime: 10 * 60_000,
  });

  const create = useMutation({
    mutationFn: () => {
      const parts = repository.trim().replace(/^https:\/\/github.com\//, "").replace(/\.git$/, "").split("/");
      if (route === "github" && !repository.trim()) throw new Error("Enter the repository as owner/name, or go back and choose hosting.");
      if (repository.trim() && parts.length !== 2) throw new Error("Enter the repository as owner/name.");
      return api.post<{ id: string; pageId: string | null }>("/website/sites", {
        name,
        publicUrl,
        repoOwner: route === "github" && repository.trim() ? parts[0] : null,
        repoName: route === "github" && repository.trim() ? parts[1] : null,
        repoBranch: branch,
        templateKey: route === "hosted" && !html && !packageData ? templateKey : undefined,
        html,
        packageData,
        packageFilename,
      });
    },
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: ["website"] });
      setOpen(false);
      navigate(result.pageId ? `/website/pages/${result.pageId}?walkthrough=interactive` : "/website/sites");
    },
  });

  const askForHelp = useMutation({
    mutationFn: () =>
      api.post<{ paymentUrl: string | null; message: string }>("/website/setup-assistance", {
        route: route ?? "hosted",
        websiteUrl: publicUrl || undefined,
        notes: helpNotes || undefined,
      }),
    onSuccess: (result) => {
      setHelpAsked(result.message);
      if (result.paymentUrl) window.open(result.paymentUrl, "_blank", "noopener");
    },
  });

  function close() {
    setOpen(false);
    setRoute(null);
    setHelpAsked(null);
    setHelpNotes("");
  }

  const price = assistance.data?.display ?? "GHS 120";

  return (
    <>
      <Button
        onClick={() => {
          create.reset();
          askForHelp.reset();
          setRoute(null);
          setHelpAsked(null);
          setOpen(true);
        }}
      >
        Connect a website
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="connect-title"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !create.isPending) close();
          }}
        >
          <div className="w-full max-w-lg space-y-5 rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="connect-title" className="font-display text-xl">
                  {route === null ? "Bring your website" : route === "hosted" ? "Import a whole project or framework" : route === "wordpress" ? "Connect your WordPress website" : "Publish to your repository"}
                </h2>
                {route !== null && (
                  <button type="button" className="mt-1 text-xs text-muted underline" onClick={() => setRoute(null)}>
                    ← Choose a different way
                  </button>
                )}
              </div>
              <button type="button" aria-label="Close" onClick={close} disabled={create.isPending}>
                Close
              </button>
            </div>

            {/* ------------------------------------------------ the choice */}
            {route === null && (
              <div className="space-y-3">
                <p className="text-sm text-muted">
                  There are three ways in. Pick whichever describes you — you can change it later.
                </p>

                <button
                  type="button"
                  className="block w-full rounded-xl border border-line p-4 text-left hover:border-line-strong"
                  onClick={() => setRoute("hosted")}
                >
                  <span className="block text-sm font-semibold text-ink">Import a framework or full project</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted">
                    Import a ZIP archive or folder containing a full website framework (Next.js, Astro, Vite, HTML). All pages, images, and links are extracted and connected under one website for editing.
                  </span>
                </button>

                <button
                  type="button"
                  className="block w-full rounded-xl border border-line p-4 text-left hover:border-line-strong"
                  onClick={() => setRoute("github")}
                >
                  <span className="block text-sm font-semibold text-ink">I have a GitHub repository</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted">
                    Publishing commits to your repository on your branch, exactly as a developer would. Choose this if your
                    site is already deployed from GitHub and you want to keep that.
                  </span>
                </button>

                <button
                  type="button"
                  className="block w-full rounded-xl border border-line p-4 text-left hover:border-line-strong"
                  onClick={() => setRoute("wordpress")}
                >
                  <span className="block text-sm font-semibold text-ink">I have a WordPress website</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted">
                    Edit your WordPress pages here and publish straight back into WordPress. Nothing to install — you make
                    an Application Password in your WordPress profile and paste it in. Your theme and hosting stay as they are.
                  </span>
                </button>

                <div className="rounded-xl bg-sunken p-4">
                  <p className="text-sm font-semibold text-ink">Would rather not do it yourself?</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    We will connect it for you — domain, DNS or repository — for a one-off {price}. Usually done the same
                    working day.
                  </p>
                  <Button size="sm" variant="secondary" className="mt-3" onClick={() => setRoute("hosted")}>
                    Start, and ask for help
                  </Button>
                </div>
              </div>
            )}

            {/* ------------------------------------------------ WordPress */}
            {route === "wordpress" && (
              <>
                <ConnectWordPress guide={assistance.data?.guides.wordpress} onConnected={close} />
                <div className="rounded-xl bg-sunken p-4">
                  {helpAsked ? (
                    <p className="text-sm text-ink">{helpAsked}</p>
                  ) : (
                    <>
                      <p className="text-sm font-semibold text-ink">Stuck? We will do it for you — {price}</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted">
                        We make the Application Password with you, sort out anything a security plugin or your host is
                        blocking, and make the first publish together.
                      </p>
                      <textarea
                        rows={2}
                        value={helpNotes}
                        onChange={(event) => setHelpNotes(event.target.value)}
                        placeholder="Your website address, and what happened when you tried…"
                        className="mt-3 w-full rounded-xl border border-line bg-white px-3 py-2 text-xs"
                      />
                      <Button size="sm" variant="secondary" className="mt-3" disabled={askForHelp.isPending} onClick={() => askForHelp.mutate()}>
                        {askForHelp.isPending ? "Requesting…" : `Set it up for me · ${price}`}
                      </Button>
                      {askForHelp.error && (
                        <p role="alert" className="mt-2 text-xs text-danger-text">
                          {(askForHelp.error as Error).message}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </>
            )}

            {/* ------------------------------------------------ either form */}
            {(route === "hosted" || route === "github") && (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  create.mutate();
                }}
              >
                <p className="text-sm leading-relaxed text-muted">
                  {route === "hosted" ? (
                    <>
                      Name your website and upload your project archive (ZIP) or select a project folder. Frameworks
                      like Next.js, Astro, Vite, or multi-page HTML are automatically detected, compiled, and turned
                      into standalone pages connected under your website.
                    </>
                  ) : (
                    <>
                      Enter the repository as <code>owner/name</code> and the branch your site is deployed from. Installing
                      the GitHub app and the first publish are covered in{" "}
                      <a className="text-blue underline" href={assistance.data?.guides.github ?? GUIDE.github} target="_blank" rel="noreferrer">
                        the repository guide
                      </a>
                      .
                    </>
                  )}
                </p>

                <label className="block text-xs text-muted">
                  Website name
                  <input
                    autoFocus
                    required
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className="mt-1 h-10 w-full rounded-xl border border-line px-3 text-sm text-ink"
                  />
                </label>
                <label className="block text-xs text-muted">
                  {route === "hosted" ? "Original website address (optional)" : "Public website address"}
                  <input
                    required={route !== "hosted"}
                    type="url"
                    value={publicUrl}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder={route === "hosted" ? "https://your-site.com (optional)" : "https://your-site.com"}
                    className="mt-1 h-10 w-full rounded-xl border border-line px-3 text-sm text-ink"
                  />
                </label>

                {route === "hosted" && !html && (
                  <label className="block text-xs text-muted">
                    Starter template
                    <select
                      value={templateKey}
                      onChange={(event) => setTemplateKey(event.target.value)}
                      className="mt-1 h-10 w-full rounded-xl border border-line bg-white px-3 text-sm text-ink outline-none"
                    >
                      <option value="business">Modern Business &amp; Consulting (Hero, Features, Reviews, CTA, Contact)</option>
                      <option value="saas">Digital Product &amp; SaaS (Hero, Features, Pricing, FAQ, CTA)</option>
                      <option value="portfolio">Creative Portfolio &amp; Studio (Hero, Features, Team, Reviews, Contact)</option>
                      <option value="local">Local Services &amp; Storefront (Hero, Features, Pricing, Reviews, Contact)</option>
                      <option value="blank">Clean Minimalist Canvas (Header, Hero, Footer)</option>
                    </select>
                  </label>
                )}

                {route === "github" && (
                  <>
                    <label className="block text-xs text-muted">
                      GitHub repository
                      <input
                        required
                        value={repository}
                        onChange={(event) => setRepo(event.target.value)}
                        placeholder="owner/repository"
                        className="mt-1 h-10 w-full rounded-xl border border-line px-3 text-sm text-ink"
                      />
                    </label>
                    <label className="block text-xs text-muted">
                      Branch
                      <input
                        required
                        value={branch}
                        onChange={(event) => setBranch(event.target.value)}
                        className="mt-1 h-10 w-full rounded-xl border border-line px-3 text-sm text-ink"
                      />
                    </label>
                  </>
                )}

                <div
                  className={`relative rounded-xl border border-dashed p-4 text-sm transition-colors ${
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
                    setFileError(null);
                    setHtml(undefined);
                    setPackageData(undefined);
                    setPackageFilename(undefined);
                    setFilename("");

                    try {
                      const items = e.dataTransfer.items;
                      if (!items || items.length === 0) return;

                      // Check if it's a single dropped file
                      if (items.length === 1 && !items[0].webkitGetAsEntry()?.isDirectory) {
                        const file = items[0].getAsFile();
                        if (!file) return;
                        const isZip = file.name.toLowerCase().endsWith(".zip") || file.type === "application/zip";
                        if (isZip && file.size > 2 * 1024 * 1024 * 1024) {
                          setFileError("Choose a ZIP package smaller than 2 GB.");
                          return;
                        }
                        if (isZip) {
                          const base64 = await fileToBase64(file);
                          setPackageData(base64);
                          setPackageFilename(file.name);
                          setFilename(file.name);
                          if (!name) {
                            const siteName = file.name.replace(/\.zip$/i, "").replace(/[-_]/g, " ");
                            setName(siteName.charAt(0).toUpperCase() + siteName.slice(1));
                          }
                          return;
                        }
                        if (file.name.toLowerCase().endsWith(".html") || file.name.toLowerCase().endsWith(".htm")) {
                          setHtml(await file.text());
                          setFilename(file.name);
                          if (!name) {
                            const siteName = file.name.replace(/\.html?$/i, "").replace(/[-_]/g, " ");
                            setName(siteName.charAt(0).toUpperCase() + siteName.slice(1));
                          }
                          return;
                        }
                      }

                      // Directory or multiple files dropped: extract and zip
                      setIsPackaging(true);
                      const extracted = await getFilesFromDataTransfer(items);
                      if (extracted.length === 0) {
                        setFileError("No readable files found in the dropped item.");
                        setIsPackaging(false);
                        return;
                      }

                      const folderName = items[0].webkitGetAsEntry()?.name || "website-package";
                      const zipped = await zipFilesToBase64(extracted, `${folderName}.zip`);
                      setPackageData(zipped.base64);
                      setPackageFilename(zipped.filename);
                      setFilename(`${folderName} (${zipped.fileCount} files)`);
                      if (!name) {
                        const siteName = folderName.replace(/\.zip$/i, "").replace(/[-_]/g, " ");
                        setName(siteName.charAt(0).toUpperCase() + siteName.slice(1));
                      }
                    } catch (err: any) {
                      setFileError(err?.message || "Failed to process dropped files.");
                    } finally {
                      setIsPackaging(false);
                    }
                  }}
                >
                  <div className="flex flex-col gap-2">
                    <span className="font-medium text-ink">
                      Import an HTML page, ZIP package, or project folder
                    </span>
                    <span className="text-xs text-muted">
                      Drag and drop your project folder or ZIP archive here, or choose an option:
                    </span>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <label className="cursor-pointer rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink shadow-sm hover:bg-surface-hover">
                        Choose file or ZIP
                        <input
                          type="file"
                          accept=".html,.htm,.zip,application/zip,text/html"
                          className="hidden"
                          onChange={async (event) => {
                            const file = event.target.files?.[0];
                            setFileError(null);
                            setHtml(undefined);
                            setPackageData(undefined);
                            setPackageFilename(undefined);
                            setFilename("");
                            if (!file) return;
                            const isZip = file.name.toLowerCase().endsWith(".zip") || file.type === "application/zip";
                            if (isZip && file.size > 2 * 1024 * 1024 * 1024) {
                              setFileError("Choose a ZIP package smaller than 2 GB.");
                              return;
                            }
                            if (!isZip && file.size > 2 * 1024 * 1024 * 1024) {
                              setFileError("Choose an HTML file smaller than 2 GB.");
                              return;
                            }
                            try {
                              if (isZip) {
                                const base64 = await fileToBase64(file);
                                setPackageData(base64);
                                setPackageFilename(file.name);
                                setFilename(file.name);
                                if (!name) {
                                  const siteName = file.name.replace(/\.zip$/i, "").replace(/[-_]/g, " ");
                                  setName(siteName.charAt(0).toUpperCase() + siteName.slice(1));
                                }
                              } else {
                                setHtml(await file.text());
                                setFilename(file.name);
                                if (!name) {
                                  const siteName = file.name.replace(/\.html?$/i, "").replace(/[-_]/g, " ");
                                  setName(siteName.charAt(0).toUpperCase() + siteName.slice(1));
                                }
                              }
                            } catch {
                              setFileError("That file could not be read.");
                            }
                          }}
                        />
                      </label>

                      <label className="cursor-pointer rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink shadow-sm hover:bg-surface-hover">
                        Choose project folder
                        <input
                          type="file"
                          {...({ webkitdirectory: "", directory: "", multiple: true } as any)}
                          className="hidden"
                          onChange={async (event) => {
                            const files = event.target.files;
                            setFileError(null);
                            setHtml(undefined);
                            setPackageData(undefined);
                            setPackageFilename(undefined);
                            setFilename("");
                            if (!files || files.length === 0) return;

                            setIsPackaging(true);
                            try {
                              const fileEntries = Array.from(files).map((f) => ({
                                file: f,
                                path: f.webkitRelativePath || f.name,
                              }));
                              const firstPart = fileEntries[0]?.path.split("/")[0] || "project";
                              const zipped = await zipFilesToBase64(fileEntries, `${firstPart}.zip`);
                              setPackageData(zipped.base64);
                              setPackageFilename(zipped.filename);
                              setFilename(`${firstPart} (${zipped.fileCount} files)`);
                              if (!name) {
                                const siteName = firstPart.replace(/[-_]/g, " ");
                                setName(siteName.charAt(0).toUpperCase() + siteName.slice(1));
                              }
                            } catch (err: any) {
                              setFileError(err?.message || "Failed to package folder.");
                            } finally {
                              setIsPackaging(false);
                            }
                          }}
                        />
                      </label>

                      {(filename || isPackaging) && (
                        <button
                          type="button"
                          className="rounded-lg px-2 py-1 text-xs text-muted hover:text-ink"
                          onClick={() => {
                            setHtml(undefined);
                            setPackageData(undefined);
                            setPackageFilename(undefined);
                            setFilename("");
                            setFileError(null);
                          }}
                        >
                          Clear
                        </button>
                      )}
                    </div>

                    {isPackaging && (
                      <span className="mt-2 block text-xs text-primary animate-pulse">
                        Packaging project folder into archive…
                      </span>
                    )}

                    {filename && !isPackaging && (
                      <span className="mt-2 block text-xs font-medium text-emerald-600">
                        ✓ {packageData
                          ? `Package ${filename} ready to import (pages, CSS, fonts, and images).`
                          : `${filename} ready to import.`}
                      </span>
                    )}
                  </div>
                </div>

                <p className="text-xs leading-relaxed text-muted">
                  Package ZIPs and folders discover local CSS, images, and fonts automatically. Multi-page projects and
                  frameworks (Next.js, Astro, Vite, HTML) are compiled into standalone pages interconnected under your website.
                </p>

                {(create.error || fileError) && (
                  <p role="alert" className="text-sm text-danger-text">
                    {fileError || (create.error as Error).message}
                  </p>
                )}

                <div className="flex justify-end gap-2">
                  <Button variant="ghost" type="button" onClick={close}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={create.isPending || !!fileError}>
                    {create.isPending ? "Connecting…" : "Open website"}
                  </Button>
                </div>

                {/* ------------------------------------------ do it for me */}
                <div className="rounded-xl bg-sunken p-4">
                  {helpAsked ? (
                    <p className="text-sm text-ink">{helpAsked}</p>
                  ) : (
                    <>
                      <p className="text-sm font-semibold text-ink">Stuck? We will do it for you — {price}</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted">
                        {route === "hosted"
                          ? "We prepare your framework archive, verify all pages and ensure everything connects cleanly."
                          : "We install the GitHub app, connect the repository and make the first publish with you."}
                      </p>
                      <textarea
                        rows={2}
                        value={helpNotes}
                        onChange={(event) => setHelpNotes(event.target.value)}
                        placeholder="Anything we should know? Who manages your domain, what you have already tried…"
                        className="mt-3 w-full rounded-xl border border-line bg-white px-3 py-2 text-xs"
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        className="mt-3"
                        disabled={askForHelp.isPending}
                        onClick={() => askForHelp.mutate()}
                      >
                        {askForHelp.isPending ? "Requesting…" : `Set it up for me · ${price}`}
                      </Button>
                      {askForHelp.error && (
                        <p role="alert" className="mt-2 text-xs text-danger-text">
                          {(askForHelp.error as Error).message}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
