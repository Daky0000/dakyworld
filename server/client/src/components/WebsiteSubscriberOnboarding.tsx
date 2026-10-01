import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Badge, Button } from "./ui";
import { useWebsiteTierStatus, notifyTierStatusChanged } from "./WebsiteTierStatusBanner";

export type StarterTemplateKey = "business" | "saas" | "portfolio" | "local" | "blank";

export interface StarterTemplateInfo {
  key: StarterTemplateKey;
  name: string;
  tagline: string;
  description: string;
  recommendedFor: string;
  sections: string[];
}

const DEFAULT_TEMPLATES: StarterTemplateInfo[] = [
  {
    key: "business",
    name: "Modern Business & Consulting",
    tagline: "Corporate, advisory, and professional services",
    description: "High-impact hero with lead capture CTA, core advantages, client testimonials, and contact details.",
    recommendedFor: "Consulting firms, corporate agencies, and service providers",
    sections: ["Hero", "Features", "Reviews", "CTA", "Contact"],
  },
  {
    key: "saas",
    name: "Digital Product & SaaS",
    tagline: "Software, web apps, and modern platforms",
    description: "Product-led hero banner, platform advantages, tiered pricing cards, FAQ accordion, and conversion CTA.",
    recommendedFor: "Tech startups, SaaS founders, and digital product studios",
    sections: ["Hero", "Features", "Pricing", "FAQ", "CTA"],
  },
  {
    key: "portfolio",
    name: "Creative Portfolio & Studio",
    tagline: "Designers, photographers, and creative agencies",
    description: "Bold visual showcase, core competencies, team leadership profiles, client reviews, and direct contact inquiry.",
    recommendedFor: "Designers, architects, photographers, and boutique creative studios",
    sections: ["Hero", "Features", "Team", "Reviews", "Contact"],
  },
  {
    key: "local",
    name: "Local Services & Storefront",
    tagline: "Local businesses, clinics, gyms, and retail",
    description: "Local service headline, core service highlights, clear pricing options, customer reviews, and direct booking contact.",
    recommendedFor: "Medical practices, gyms, salons, contractors, and local storefronts",
    sections: ["Hero", "Features", "Pricing", "Reviews", "Contact"],
  },
  {
    key: "blank",
    name: "Clean Minimalist Canvas",
    tagline: "Clean slate with semantic navigation and responsive structure",
    description: "Clean canvas with standard header, minimalist hero, and footer ready for custom sections.",
    recommendedFor: "Developers and designers building custom layouts from scratch",
    sections: ["Hero", "CTA"],
  },
];

type SetupRoute = "template" | "github" | "import" | "concierge";

export function WebsiteSubscriberOnboarding({
  onSiteCreated,
  initialRoute = "template",
}: {
  onSiteCreated?: (siteId: string, pageId: string | null) => void;
  initialRoute?: SetupRoute;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { status: tierStatus } = useWebsiteTierStatus();

  const [activeStep, setActiveStep] = useState<1 | 2 | 3 | 4>(1);
  const [route, setRoute] = useState<SetupRoute>(initialRoute);
  const [selectedTemplate, setSelectedTemplate] = useState<StarterTemplateKey>("business");

  // Form states
  const [siteName, setSiteName] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#3157ff");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubBranch, setGithubBranch] = useState("main");
  const [importedHtml, setImportedHtml] = useState<string | undefined>();
  const [importedFileName, setImportedFileName] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);

  // Concierge assistance state
  const [helpNotes, setHelpNotes] = useState("");
  const [helpSuccess, setHelpSuccess] = useState<string | null>(null);

  // Result state
  const [createdResult, setCreatedResult] = useState<{ siteId: string; pageId: string | null } | null>(null);
  const [provisioningDone, setProvisioningDone] = useState(false);

  // Fetch live templates from server if available
  const templatesQuery = useQuery({
    queryKey: ["website", "starter-templates"],
    queryFn: ({ signal }) => api.get<StarterTemplateInfo[]>("/website/starter-templates", signal),
    staleTime: 60 * 60_000,
  });

  const templates = templatesQuery.data?.length ? templatesQuery.data : DEFAULT_TEMPLATES;

  // Create website mutation
  const createSite = useMutation({
    mutationFn: async () => {
      const trimmedName = siteName.trim();
      const trimmedUrl = publicUrl.trim();
      if (!trimmedName) throw new Error("Please enter your website name.");
      if (!trimmedUrl) throw new Error("Please enter your public website address or domain.");

      let repoOwner: string | null = null;
      let repoName: string | null = null;

      if (route === "github") {
        const parts = githubRepo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").split("/");
        if (parts.length !== 2) throw new Error("Enter the repository as owner/repository (e.g. acme/website).");
        repoOwner = parts[0];
        repoName = parts[1];
      }

      return api.post<{ id: string; pageId: string | null }>("/website/sites", {
        name: trimmedName,
        publicUrl: trimmedUrl.startsWith("http") ? trimmedUrl : `https://${trimmedUrl}`,
        repoOwner,
        repoName,
        repoBranch: route === "github" ? githubBranch : "main",
        templateKey: route === "template" ? selectedTemplate : undefined,
        html: route === "import" ? importedHtml : undefined,
      });
    },
    onSuccess: async (result) => {
      setCreatedResult({ siteId: result.id, pageId: result.pageId });
      setActiveStep(3);
      await qc.invalidateQueries({ queryKey: ["website"] });
      notifyTierStatusChanged();

      // Simulate the verification and provisioning sequence
      setTimeout(() => {
        setProvisioningDone(true);
        setActiveStep(4);
        onSiteCreated?.(result.id, result.pageId);
      }, 1800);
    },
  });

  // Request concierge help mutation
  const requestHelp = useMutation({
    mutationFn: () =>
      api.post<{ paymentUrl: string | null; message: string }>("/website/setup-assistance", {
        route: "hosted",
        websiteUrl: publicUrl || undefined,
        notes: helpNotes || undefined,
      }),
    onSuccess: (result) => {
      setHelpSuccess(result.message);
      if (result.paymentUrl) window.open(result.paymentUrl, "_blank", "noopener");
    },
  });

  const handleLaunchEditor = () => {
    if (createdResult?.pageId) {
      navigate(`/website/pages/${createdResult.pageId}?walkthrough=interactive`);
    } else if (createdResult?.siteId) {
      navigate(`/website/sites`);
    }
  };

  const planName = tierStatus?.tierName ?? "Website Builder Subscriber";
  const planBadge = tierStatus?.tierBadge ?? "Subscribed Plan";
  const priceDisplay = tierStatus?.pricing.priceDisplay ?? "";

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Onboarding Welcome Banner */}
      <div className="relative overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-white via-white to-blue/5 p-6 shadow-sm sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="font-sans text-[11px] font-bold uppercase tracking-[.08em] text-muted">
                Subscriber Onboarding Experience
              </span>
              <Badge tone="positive">{planBadge}</Badge>
            </div>
            <h1 className="font-display text-2xl font-bold tracking-[-.03em] text-ink sm:text-3xl">
              Welcome to DakyXTech Website Builder
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-muted">
              Connect your website in under a minute, preview across devices, and seamlessly jump forward into our visual in-place editor with an interactive walkthrough.
            </p>
          </div>

          {tierStatus && (
            <div className="rounded-2xl border border-line bg-white/90 p-4 text-right shadow-2xs backdrop-blur">
              <div className="text-xs text-muted">Active Subscription</div>
              <div className="font-display text-base font-bold text-ink">{planName}</div>
              {priceDisplay && <div className="text-xs font-semibold text-blue">{priceDisplay}/mo</div>}
              <div className="mt-1 text-[11px] text-muted">
                {tierStatus.storage.quotaFormatted} Storage · {tierStatus.features.visualEditor ? "Visual Editor" : "Standard"}
              </div>
            </div>
          )}
        </div>

        {/* Step Progress Stepper */}
        <div className="mt-8 grid grid-cols-4 gap-2 border-t border-line/60 pt-6">
          {[
            { num: 1, label: "Your Plan" },
            { num: 2, label: "Connect Website" },
            { num: 3, label: "Provisioning" },
            { num: 4, label: "Edit & Tour" },
          ].map((s) => {
            const isCompleted = activeStep > s.num;
            const isCurrent = activeStep === s.num;
            return (
              <div key={s.num} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <div
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold transition-all ${
                      isCompleted
                        ? "bg-emerald-500 text-white"
                        : isCurrent
                          ? "bg-ink text-white ring-2 ring-blue/30"
                          : "border border-line bg-sunken/40 text-muted"
                    }`}
                  >
                    {isCompleted ? "✓" : s.num}
                  </div>
                  <span
                    className={`text-xs font-medium transition-colors ${
                      isCurrent ? "font-bold text-ink" : isCompleted ? "text-slate-700" : "text-muted"
                    }`}
                  >
                    {s.label}
                  </span>
                </div>
                <div
                  className={`mt-1 h-1 w-full rounded-full transition-all duration-300 ${
                    isCompleted ? "bg-emerald-500" : isCurrent ? "bg-blue" : "bg-sunken"
                  }`}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* STEP 1: Plan Confirmation & Connection Mode Selection */}
      {activeStep === 1 && (
        <div className="space-y-6 rounded-3xl border border-line bg-white p-6 shadow-xs sm:p-8">
          <div>
            <h2 className="font-display text-xl font-bold tracking-[-.02em] text-ink">
              Step 1: Choose How to Connect Your Website
            </h2>
            <p className="mt-1 text-sm text-muted">
              Select the setup method that fits your workflow. You can start immediately with our modern responsive templates, connect your existing repository, or import an HTML document.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => {
                setRoute("template");
                setActiveStep(2);
              }}
              className="flex flex-col justify-between rounded-2xl border-2 border-blue bg-blue/5 p-5 text-left transition hover:border-blue hover:shadow-md"
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="rounded-full bg-blue px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                    Recommended
                  </span>
                  <span className="text-xl">✨</span>
                </div>
                <h3 className="mt-3 font-display text-base font-bold text-ink">
                  Launch with a High-Converting Starter Template
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">
                  Instant 10-second setup. Choose from our curated responsive business, SaaS, portfolio, or local storefront layouts. Ready to edit immediately.
                </p>
              </div>
              <div className="mt-4 flex items-center gap-1 text-xs font-bold text-blue">
                <span>Configure template</span>
                <span>→</span>
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                setRoute("github");
                setActiveStep(2);
              }}
              className="flex flex-col justify-between rounded-2xl border border-line bg-white p-5 text-left transition hover:border-ink hover:shadow-md"
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="rounded-full border border-line bg-sunken px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted">
                    Developers & Teams
                  </span>
                  <span className="text-xl">🐙</span>
                </div>
                <h3 className="mt-3 font-display text-base font-bold text-ink">
                  Connect Existing GitHub Repository
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">
                  Publishing commits to your repository branch with zero downtime. Keeps full version history and works with your CI/CD pipeline.
                </p>
              </div>
              <div className="mt-4 flex items-center gap-1 text-xs font-bold text-ink">
                <span>Connect repository</span>
                <span>→</span>
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                setRoute("import");
                setActiveStep(2);
              }}
              className="flex flex-col justify-between rounded-2xl border border-line bg-white p-5 text-left transition hover:border-ink hover:shadow-md"
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="rounded-full border border-line bg-sunken px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted">
                    Custom Code
                  </span>
                  <span className="text-xl">📄</span>
                </div>
                <h3 className="mt-3 font-display text-base font-bold text-ink">
                  Import HTML Page or Design File
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">
                  Upload an existing HTML page. Embedded media is automatically imported into your private media library.
                </p>
              </div>
              <div className="mt-4 flex items-center gap-1 text-xs font-bold text-ink">
                <span>Upload HTML</span>
                <span>→</span>
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                setRoute("concierge");
                setActiveStep(2);
              }}
              className="flex flex-col justify-between rounded-2xl border border-line bg-white p-5 text-left transition hover:border-ink hover:shadow-md"
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="rounded-full border border-line bg-sunken px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted">
                    White-Glove Support
                  </span>
                  <span className="text-xl">🤝</span>
                </div>
                <h3 className="mt-3 font-display text-base font-bold text-ink">
                  DakyXTech Concierge Setup Assistance
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">
                  Would rather not configure DNS or repositories yourself? Our engineering team sets up your custom domain and initial pages.
                </p>
              </div>
              <div className="mt-4 flex items-center gap-1 text-xs font-bold text-ink">
                <span>Request concierge</span>
                <span>→</span>
              </div>
            </button>
          </div>
        </div>
      )}

      {/* STEP 2: Configure & Connect Website */}
      {activeStep === 2 && (
        <div className="space-y-6 rounded-3xl border border-line bg-white p-6 shadow-xs sm:p-8">
          <div className="flex items-center justify-between border-b border-line pb-4">
            <div>
              <h2 className="font-display text-xl font-bold tracking-[-.02em] text-ink">
                Step 2: Connect Your Website Details
              </h2>
              <p className="mt-1 text-xs text-muted">
                {route === "template"
                  ? "Choose your starting template and enter your website address."
                  : route === "github"
                    ? "Enter your GitHub repository and deployment branch."
                    : route === "import"
                      ? "Select your HTML file to import into the editor."
                      : "Tell us what you need help configuring."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setActiveStep(1)}
              className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-muted hover:border-ink hover:text-ink"
            >
              ← Change Method
            </button>
          </div>

          {/* TEMPLATE PICKER (when route === "template") */}
          {route === "template" && (
            <div className="space-y-4">
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted">
                Select Starter Template
              </label>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((tpl) => {
                  const isSelected = selectedTemplate === tpl.key;
                  return (
                    <button
                      key={tpl.key}
                      type="button"
                      onClick={() => setSelectedTemplate(tpl.key)}
                      className={`flex flex-col justify-between rounded-xl border p-4 text-left transition ${
                        isSelected
                          ? "border-blue bg-blue/5 shadow-xs ring-2 ring-blue/20"
                          : "border-line bg-white hover:border-line-strong"
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="font-display text-sm font-bold text-ink">{tpl.name}</span>
                          {isSelected && <span className="text-xs font-bold text-blue">✓ Selected</span>}
                        </div>
                        <p className="mt-1 text-[11px] leading-relaxed text-muted">{tpl.description}</p>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1">
                        {tpl.sections.map((sec) => (
                          <span
                            key={sec}
                            className="rounded-md bg-sunken px-1.5 py-0.5 text-[9px] font-semibold text-muted"
                          >
                            {sec}
                          </span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* GITHUB FORM */}
          {route === "github" && (
            <div className="space-y-4 rounded-2xl border border-line bg-sunken/20 p-5">
              <label className="block text-xs font-medium text-ink">
                GitHub Repository (owner/repository)
                <input
                  type="text"
                  required
                  placeholder="e.g. acme-corp/website"
                  value={githubRepo}
                  onChange={(e) => setGithubRepo(e.target.value)}
                  className="mt-1.5 h-10 w-full rounded-xl border border-line bg-white px-3 text-sm text-ink outline-none focus:border-blue"
                />
              </label>
              <label className="block text-xs font-medium text-ink">
                Deployment Branch
                <input
                  type="text"
                  required
                  placeholder="main"
                  value={githubBranch}
                  onChange={(e) => setGithubBranch(e.target.value)}
                  className="mt-1.5 h-10 w-full rounded-xl border border-line bg-white px-3 text-sm text-ink outline-none focus:border-blue"
                />
              </label>
            </div>
          )}

          {/* HTML IMPORT FORM */}
          {route === "import" && (
            <div className="space-y-4 rounded-2xl border border-line bg-sunken/20 p-5">
              <label className="block text-xs font-medium text-ink">
                Upload HTML File (Max 2 MB)
                <input
                  type="file"
                  accept=".html,.htm,text/html"
                  className="mt-2 block w-full text-xs"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    setFileError(null);
                    setImportedHtml(undefined);
                    setImportedFileName("");
                    if (!file) return;
                    if (file.size > 2_000_000) {
                      setFileError("Please choose an HTML file smaller than 2 MB.");
                      return;
                    }
                    try {
                      const text = await file.text();
                      setImportedHtml(text);
                      setImportedFileName(file.name);
                      if (!siteName) {
                        const suggested = file.name.replace(/\.html?$/i, "").replace(/[-_]/g, " ");
                        setSiteName(suggested);
                      }
                    } catch {
                      setFileError("That file could not be read.");
                    }
                  }}
                />
              </label>
              {importedFileName && (
                <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">
                  <span>✓</span>
                  <span>{importedFileName} is loaded and ready to import.</span>
                </div>
              )}
              {fileError && <p className="text-xs text-red-600">{fileError}</p>}
            </div>
          )}

          {/* CONCIERGE FORM */}
          {route === "concierge" && (
            <div className="space-y-4 rounded-2xl border border-line bg-sunken/20 p-5">
              <p className="text-sm leading-relaxed text-muted">
                Our team will configure your custom domain, set up DNS records, or assist with repository permissions. Describe your website requirements:
              </p>
              <textarea
                rows={3}
                value={helpNotes}
                onChange={(e) => setHelpNotes(e.target.value)}
                placeholder="Domain name, registrar (e.g. Namecheap, GoDaddy), or repository details..."
                className="w-full rounded-xl border border-line bg-white p-3 text-xs text-ink outline-none focus:border-blue"
              />
              <Button
                variant="primary"
                disabled={requestHelp.isPending || !!helpSuccess}
                onClick={() => requestHelp.mutate()}
              >
                {requestHelp.isPending ? "Submitting Request…" : "Submit Concierge Request"}
              </Button>
              {helpSuccess && <p className="text-xs font-semibold text-emerald-700">{helpSuccess}</p>}
            </div>
          )}

          {/* COMMON WEBSITE DETAILS (Name & URL) */}
          {route !== "concierge" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                createSite.mutate();
              }}
              className="space-y-4 border-t border-line/60 pt-4"
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-xs font-semibold text-ink">
                  Website Name
                  <input
                    type="text"
                    required
                    placeholder="e.g. Apex Studio"
                    value={siteName}
                    onChange={(e) => {
                      setSiteName(e.target.value);
                      if (!publicUrl) {
                        const slug = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "");
                        if (slug) setPublicUrl(`https://${slug}.com`);
                      }
                    }}
                    className="mt-1.5 h-10 w-full rounded-xl border border-line px-3 text-sm text-ink outline-none focus:border-blue"
                  />
                </label>

                <label className="block text-xs font-semibold text-ink">
                  Public Website Address / Domain
                  <input
                    type="url"
                    required
                    placeholder="https://apexstudio.com"
                    value={publicUrl}
                    onChange={(e) => setPublicUrl(e.target.value)}
                    className="mt-1.5 h-10 w-full rounded-xl border border-line px-3 text-sm text-ink outline-none focus:border-blue"
                  />
                </label>
              </div>

              {createSite.error && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                  {createSite.error instanceof ApiError ? createSite.error.message : (createSite.error as Error).message}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-3">
                <Button variant="ghost" type="button" onClick={() => setActiveStep(1)}>
                  Back
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={createSite.isPending || !siteName.trim() || !publicUrl.trim()}
                >
                  {createSite.isPending ? "Connecting Website…" : "Connect Website & Launch Editor →"}
                </Button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* STEP 3: Automated Provisioning & Verification Sequence */}
      {activeStep === 3 && (
        <div className="rounded-3xl border border-line bg-white p-8 text-center shadow-xs">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue/10 text-2xl text-blue animate-bounce">
            ⚙️
          </div>
          <h2 className="mt-4 font-display text-xl font-bold tracking-[-.02em] text-ink">
            Provisioning Your Website Workspace…
          </h2>
          <p className="mt-1 text-sm text-muted">
            Configuring zero-downtime hosting, compiling responsive layout tokens, and preparing your editor.
          </p>

          <div className="mx-auto mt-6 max-w-md space-y-3 text-left">
            <div className="flex items-center gap-3 text-xs font-medium text-ink">
              <span className="text-emerald-500 font-bold">✓</span>
              <span>Subscriber entitlement & plan quotas verified</span>
            </div>
            <div className="flex items-center gap-3 text-xs font-medium text-ink">
              <span className="text-emerald-500 font-bold">✓</span>
              <span>Domain {publicUrl} mapped to private workspace</span>
            </div>
            <div className="flex items-center gap-3 text-xs font-medium text-ink">
              <span className="text-emerald-500 font-bold">✓</span>
              <span>
                {route === "template"
                  ? `Starter template "${selectedTemplate}" synthesized with semantic HTML`
                  : "HTML workspace registered and parsed"}
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs font-medium text-ink">
              <span className="text-blue font-bold animate-spin">⟳</span>
              <span>Initializing visual canvas and interactive walkthrough…</span>
            </div>
          </div>
        </div>
      )}

      {/* STEP 4: Celebration & Moving Forward to Edit in the Website Builder */}
      {activeStep === 4 && (
        <div className="relative overflow-hidden rounded-3xl border border-line bg-white p-8 text-center shadow-lg">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-emerald-100 text-3xl text-emerald-600 shadow-sm">
            🚀
          </div>
          <div className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
            <span>✓</span>
            <span>Website Successfully Connected</span>
          </div>

          <h2 className="mt-3 font-display text-2xl font-bold tracking-[-.02em] text-ink sm:text-3xl">
            {siteName} is Ready to Edit!
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-muted">
            Your website has been initialized and is ready in the visual editor. Step directly into your canvas to customize headlines, swap imagery, test responsive viewports, and launch live.
          </p>

          <div className="mx-auto mt-6 max-w-sm rounded-2xl border border-line bg-sunken/30 p-4 text-left">
            <div className="text-[11px] font-bold uppercase tracking-wider text-muted">Website Details</div>
            <div className="mt-1 font-display text-sm font-bold text-ink">{siteName}</div>
            <div className="font-mono text-xs text-blue truncate">{publicUrl}</div>
            <div className="mt-2 text-[11px] text-muted">
              Starter: <span className="font-semibold text-ink capitalize">{selectedTemplate}</span> layout with live auto-save
            </div>
          </div>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button
              variant="accent"
              size="md"
              onClick={handleLaunchEditor}
              className="w-full sm:w-auto px-8 py-3.5 text-sm font-bold shadow-md hover:shadow-lg transition-all"
            >
              Open Website Builder &amp; Start Interactive Tour →
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => navigate("/website/sites")}
              className="w-full sm:w-auto text-sm"
            >
              View Sites Dashboard
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
