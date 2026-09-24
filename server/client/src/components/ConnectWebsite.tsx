import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Button } from "./ui";

/**
 * Bringing a website in, by whichever of the two routes fits.
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
  guides: { hosted: string; github: string };
};

type Route = "hosted" | "github";

const GUIDE = {
  hosted: "https://dakyworld.com/website-builder-setup#hosted",
  github: "https://dakyworld.com/website-builder-setup#github",
};

export function ConnectWebsite() {
  const [open, setOpen] = useState(false);
  const [route, setRoute] = useState<Route | null>(null);
  const [name, setName] = useState("");
  const [publicUrl, setUrl] = useState("");
  const [repository, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [html, setHtml] = useState<string | undefined>();
  const [filename, setFilename] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [helpNotes, setHelpNotes] = useState("");
  const [helpAsked, setHelpAsked] = useState<string | null>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const assistance = useQuery({
    queryKey: ["website", "setup-assistance"],
    queryFn: () => api.get<Assistance>("/website/setup-assistance"),
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
        html,
      });
    },
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: ["website"] });
      setOpen(false);
      navigate(result.pageId ? `/website/pages/${result.pageId}` : "/website/sites");
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

  const price = assistance.data?.display ?? "$10";

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
                  {route === null ? "Bring your website" : route === "hosted" ? "We host it for you" : "Publish to your repository"}
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
                  There are two ways in. Pick whichever describes you — you can change it later.
                </p>

                <button
                  type="button"
                  className="block w-full rounded-xl border border-line p-4 text-left hover:border-line-strong"
                  onClick={() => setRoute("hosted")}
                >
                  <span className="block text-sm font-semibold text-ink">We host it for you</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted">
                    You get an address straight away and can point your own domain at it with two DNS records. Nothing to
                    install, no developer needed. Choose this if you are not sure.
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

            {/* ------------------------------------------------ either form */}
            {route !== null && (
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
                      Name it and give the address it has now (or will have). Publishing puts pages live here
                      immediately; pointing your own domain at it is two DNS records, in{" "}
                      <a className="text-blue underline" href={assistance.data?.guides.hosted ?? GUIDE.hosted} target="_blank" rel="noreferrer">
                        the hosting guide
                      </a>
                      .
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
                  Public website address
                  <input
                    required
                    type="url"
                    value={publicUrl}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://your-site.com"
                    className="mt-1 h-10 w-full rounded-xl border border-line px-3 text-sm text-ink"
                  />
                </label>

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

                <label className="block rounded-xl border border-dashed border-line-strong bg-sunken p-4 text-sm">
                  Import an HTML file (optional)
                  <input
                    type="file"
                    accept=".html,.htm,text/html"
                    className="mt-2 block w-full text-xs"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      setFileError(null);
                      setHtml(undefined);
                      setFilename("");
                      if (!file) return;
                      if (file.size > 2_000_000) {
                        setFileError("Choose a file smaller than 2 MB.");
                        return;
                      }
                      try {
                        setHtml(await file.text());
                        setFilename(file.name);
                      } catch {
                        setFileError("That file could not be read.");
                      }
                    }}
                  />
                  {filename && <span className="mt-2 block text-xs text-muted">{filename} is ready to import.</span>}
                </label>

                <p className="text-xs leading-relaxed text-muted">
                  A website address supplies relative images and styles. React/Next.js app shells require source
                  integration; uploading compiled HTML does not update React components. Imported scripts are kept in
                  downloads and disabled in the editor.
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
                          ? "We set up the domain and the DNS records and confirm it is live."
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
