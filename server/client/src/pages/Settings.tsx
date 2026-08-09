import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import type { AppSettings } from "../lib/types";
import { Badge, Button, Field, PageHeader, StatusDot } from "../components/ui";

/**
 * Everything the Owner configures, in one place.
 *
 * Each panel is the same shape on purpose: what the integration unlocks, what
 * state it's in, where to get the credential, and one form to paste it into.
 * Keys go straight into the database (encrypted, see server/src/lib/secrets.ts)
 * rather than into an environment variable, so adding or rotating one never
 * needs a redeploy. Where a deploy *has* pinned a value with an env var, the
 * panel says so and refuses to edit it — the deploy stays the source of truth
 * wherever someone chose to make it one.
 */

type SectionId = "analyst" | "google" | "capture" | "payments" | "storage" | "general";

const SECTIONS: { id: SectionId; label: string; blurb: string }[] = [
  { id: "analyst", label: "AI analyst", blurb: "Reads messy spreadsheets into leads" },
  { id: "google", label: "Google Drive", blurb: "Import a sheet without downloading it" },
  { id: "capture", label: "Lead capture", blurb: "Apify scrapers and their schedule" },
  { id: "payments", label: "Payments", blurb: "Stripe checkout links on invoices" },
  { id: "storage", label: "File storage", blurb: "Where generated PDFs are kept" },
  { id: "general", label: "General", blurb: "Public URL and default timezone" },
];

export function Settings() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [section, setSection] = useState<SectionId>((searchParams.get("tab") as SectionId) || "analyst");

  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<AppSettings>("/settings"),
  });

  // Google's consent redirect lands back here with its outcome in the URL.
  const googleResult = searchParams.get("google");
  useEffect(() => {
    if (!googleResult) return;
    setSection("google");
    void qc.invalidateQueries({ queryKey: ["settings"] });
    const timer = setTimeout(() => {
      setSearchParams(
        (params) => {
          params.delete("google");
          params.delete("message");
          params.delete("account");
          return params;
        },
        { replace: true },
      );
    }, 8000);
    return () => clearTimeout(timer);
  }, [googleResult, qc, setSearchParams]);

  const choose = (id: SectionId) => {
    setSection(id);
    setSearchParams((params) => {
      params.set("tab", id);
      return params;
    }, { replace: true });
  };

  const status = (id: SectionId): "ok" | "warn" | "idle" => {
    if (!data) return "idle";
    switch (id) {
      case "analyst":
        return data.analyst.configured ? "ok" : "idle";
      case "google":
        return data.google.connected ? "ok" : data.google.configured ? "warn" : "idle";
      case "capture":
        return data.apify.connected ? "ok" : data.apify.token ? "warn" : "idle";
      case "payments":
        return data.stripe.configured ? (data.stripe.webhookConfigured ? "ok" : "warn") : "idle";
      case "storage":
        return data.cloudinary.configured ? "ok" : "idle";
      default:
        return "ok";
    }
  };

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Keys and configuration for the whole system. Everything here is saved to the database — no redeploy needed."
      />

      <div className="grid gap-8 lg:grid-cols-[16rem_1fr]">
        <nav className="h-fit border border-ink/10 bg-white">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => choose(entry.id)}
              className={`flex w-full items-start gap-3 border-b border-ink/5 px-4 py-3 text-left transition last:border-0 ${
                section === entry.id ? "bg-ink text-ivory" : "hover:bg-ivory"
              }`}
            >
              <span className="mt-1.5">
                <StatusDot tone={status(entry.id)} />
              </span>
              <span className="min-w-0">
                <span className="block font-mono text-[11px] uppercase tracking-[.12em]">{entry.label}</span>
                <span className={`mt-0.5 block text-xs ${section === entry.id ? "text-ivory/60" : "text-ink/45"}`}>
                  {entry.blurb}
                </span>
              </span>
            </button>
          ))}
        </nav>

        <div>
          {isLoading || !data ? (
            <p className="text-sm text-ink/50">Loading…</p>
          ) : (
            <>
              {section === "analyst" && <AnalystPanel settings={data} />}
              {section === "google" && <GooglePanel settings={data} result={googleResult} params={searchParams} />}
              {section === "capture" && <CapturePanel settings={data} />}
              {section === "payments" && <PaymentsPanel settings={data} />}
              {section === "storage" && <StoragePanel settings={data} />}
              {section === "general" && <GeneralPanel settings={data} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Shared shell ----------------------------------------------------------

function Panel({
  title,
  what,
  where,
  state,
  children,
}: {
  title: string;
  /** What this unlocks — the reason to bother filling it in. */
  what: ReactNode;
  /** Where the credential comes from. */
  where?: ReactNode;
  state: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="border border-ink/10 bg-white p-6">
      <h2 className="font-serif text-2xl">{title}</h2>
      <p className="mt-1 max-w-2xl text-sm text-ink/60">{what}</p>
      <div className="mt-4 border-y border-ink/10 py-4">{state}</div>
      {where && <p className="mt-4 max-w-2xl text-sm text-ink/55">{where}</p>}
      {children}
    </section>
  );
}

function EnvNote({ variable }: { variable: string }) {
  return (
    <p className="mt-3 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      Pinned by the <code className="font-mono">{variable}</code> environment variable, so it can't be edited here. Change it in
      Railway, or remove the variable to manage it from this screen.
    </p>
  );
}

function ErrorNote({ error }: { error: unknown }) {
  if (!(error instanceof Error)) return null;
  return <p className="mt-3 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error.message}</p>;
}

/** Saving any panel returns the whole settings snapshot, so one cache key covers everything. */
function useSaveSettings() {
  const qc = useQueryClient();
  return (result: AppSettings) => qc.setQueryData(["settings"], result);
}

function Connected({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <Badge tone="gold">connected</Badge>
      {children}
    </div>
  );
}

function NotConnected({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-ink/60">
      <Badge tone="muted">not set up</Badge>
      {children}
    </div>
  );
}

// --- AI analyst ------------------------------------------------------------

function AnalystPanel({ settings }: { settings: AppSettings }) {
  const save = useSaveSettings();
  const [key, setKey] = useState("");

  const connect = useMutation({
    mutationFn: () => api.put<AppSettings>("/settings/anthropic", { key }),
    onSuccess: (result) => {
      setKey("");
      save(result);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete<AppSettings>("/settings/anthropic"),
    onSuccess: save,
  });

  const analyst = settings.analyst;

  return (
    <Panel
      title="AI analyst"
      what={
        <>
          Reads an imported spreadsheet and works out where each table starts, what every column means, and which columns don't fit
          the built-in lead fields. Without it, imports still work — the file is mapped by pattern rules instead, which need a
          reasonably tidy sheet.
        </>
      }
      where={
        !analyst.configured && (
          <>
            Create a key at{" "}
            <a className="text-bronze hover:underline" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
              console.anthropic.com → API keys
            </a>
            , and make sure the account has credit. The key is checked against Anthropic before it's saved.
          </>
        )
      }
      state={
        analyst.configured ? (
          <Connected>
            <span className="font-mono text-xs text-ink/50">{analyst.key}</span>
            <span className="text-xs text-ink/40">{analyst.model}</span>
            {!analyst.envManaged && (
              <Button variant="ghost" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Remove key
              </Button>
            )}
          </Connected>
        ) : (
          <NotConnected>Imports fall back to pattern-rule mapping.</NotConnected>
        )
      }
    >
      {analyst.envManaged ? (
        <EnvNote variable="ANTHROPIC_API_KEY" />
      ) : (
        !analyst.configured && (
          <form
            className="mt-4 flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (key.trim()) connect.mutate();
            }}
          >
            <div className="min-w-[22rem] flex-1">
              <Field label="Anthropic API key">
                <input
                  type="password"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder="sk-ant-…"
                  autoComplete="off"
                  className="input font-mono text-xs"
                />
              </Field>
            </div>
            <Button type="submit" disabled={connect.isPending || key.trim().length < 10}>
              {connect.isPending ? "Checking…" : "Save key"}
            </Button>
          </form>
        )
      )}
      <ErrorNote error={connect.error ?? remove.error} />
    </Panel>
  );
}

// --- Google Drive ----------------------------------------------------------

function GooglePanel({
  settings,
  result,
  params,
}: {
  settings: AppSettings;
  result: string | null;
  params: URLSearchParams;
}) {
  const save = useSaveSettings();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [copied, setCopied] = useState(false);

  const saveClient = useMutation({
    mutationFn: () => api.put<AppSettings>("/settings/google", { clientId, clientSecret }),
    onSuccess: (next) => {
      setClientSecret("");
      save(next);
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api.post<AppSettings>("/settings/google/disconnect"),
    onSuccess: save,
  });
  const removeClient = useMutation({
    mutationFn: () => api.delete<AppSettings>("/settings/google"),
    onSuccess: save,
  });
  const connect = useMutation({
    mutationFn: () => api.get<{ url: string }>("/settings/google/auth-url?return=/settings"),
    onSuccess: (response) => {
      window.location.href = response.url;
    },
  });

  const google = settings.google;

  return (
    <Panel
      title="Google Drive"
      what={
        <>
          Lets you pick a spreadsheet straight out of Drive instead of downloading and re-uploading it. Read-only: the app can list
          and read sheets, and nothing else. Uploading a file works without this.
        </>
      }
      state={
        google.connected ? (
          <Connected>
            <span>{google.account ?? "Google account"}</span>
            <Button variant="ghost" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
              Disconnect account
            </Button>
          </Connected>
        ) : google.configured ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge tone="muted">client saved</Badge>
            <span className="text-ink/60">Not signed in yet.</span>
            <Button size="sm" onClick={() => connect.mutate()} disabled={connect.isPending}>
              {connect.isPending ? "Redirecting…" : "Connect Google Drive"}
            </Button>
          </div>
        ) : (
          <NotConnected>Add an OAuth client below to enable it.</NotConnected>
        )
      }
    >
      {result === "connected" && (
        <p className="mt-4 border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Connected{params.get("account") ? ` as ${params.get("account")}` : ""}.
        </p>
      )}
      {result === "error" && (
        <p className="mt-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {params.get("message") ?? "The Google sign-in didn't complete."}
        </p>
      )}

      <div className="mt-5">
        <Field
          label="Authorised redirect URI"
          hint="Add this to the OAuth client in Google Cloud, exactly as shown — Google matches it character for character."
        >
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all border border-ink/10 bg-ivory px-2 py-1.5 text-xs">{google.redirectUri}</code>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(google.redirectUri);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </Field>
      </div>

      {google.envManaged ? (
        <EnvNote variable="GOOGLE_CLIENT_ID" />
      ) : (
        <>
          <form
            className="mt-4 grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (clientId.trim() && clientSecret.trim()) saveClient.mutate();
            }}
          >
            <Field label={google.configured ? "Replace client ID" : "Client ID"}>
              <input
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                placeholder={google.clientId ?? "…apps.googleusercontent.com"}
                autoComplete="off"
                className="input font-mono text-xs"
              />
            </Field>
            <Field label={google.configured ? "Replace client secret" : "Client secret"}>
              <input
                type="password"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                placeholder="GOCSPX-…"
                autoComplete="off"
                className="input font-mono text-xs"
              />
            </Field>
            <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={saveClient.isPending || !clientId.trim() || !clientSecret.trim()}>
                {saveClient.isPending ? "Saving…" : "Save client"}
              </Button>
              {google.configured && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (confirm("Remove the Google client? The connected account is signed out too.")) removeClient.mutate();
                  }}
                  disabled={removeClient.isPending}
                >
                  Remove client
                </Button>
              )}
            </div>
          </form>

          <details className="mt-5 border border-ink/10 bg-ivory">
            <summary className="cursor-pointer px-4 py-3 font-mono text-[10px] uppercase tracking-[.14em] text-ink/50">
              How to create the OAuth client
            </summary>
            <ol className="list-decimal space-y-2 px-8 py-4 text-sm text-ink/65">
              <li>
                In{" "}
                <a className="text-bronze hover:underline" href="https://console.cloud.google.com" target="_blank" rel="noreferrer">
                  console.cloud.google.com
                </a>
                , create a project.
              </li>
              <li>
                <strong>APIs &amp; Services → Library</strong>: enable the <strong>Google Drive API</strong> and the{" "}
                <strong>Google Sheets API</strong>. Both.
              </li>
              <li>
                <strong>OAuth consent screen</strong>: User type <em>External</em>, add yourself as a test user, then{" "}
                <strong>Publish app</strong> — while it stays in Testing, Google expires the connection every 7 days.
              </li>
              <li>
                <strong>Credentials → Create credentials → OAuth client ID → Web application</strong>, and add the redirect URI
                above.
              </li>
              <li>Paste the client ID and secret here, save, then Connect.</li>
            </ol>
            <p className="border-t border-ink/10 px-4 py-3 text-xs text-ink/50">
              On first sign-in Google shows “Google hasn't verified this app” — that's expected for an unverified app asking for
              read access to Drive. Choose <strong>Advanced → Go to Dakyworld OS</strong>.
            </p>
          </details>
        </>
      )}
      <ErrorNote error={saveClient.error ?? connect.error ?? disconnect.error ?? removeClient.error} />
    </Panel>
  );
}

// --- Lead capture ----------------------------------------------------------

function CapturePanel({ settings }: { settings: AppSettings }) {
  const save = useSaveSettings();
  const qc = useQueryClient();
  const [token, setToken] = useState("");

  const connect = useMutation({
    mutationFn: () => api.put<AppSettings>("/settings/apify", { token }),
    onSuccess: (result) => {
      setToken("");
      save(result);
      void qc.invalidateQueries({ queryKey: ["scraper-overview"] });
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api.delete<AppSettings>("/settings/apify"),
    onSuccess: (result) => {
      save(result);
      void qc.invalidateQueries({ queryKey: ["scraper-overview"] });
    },
  });

  const apify = settings.apify;

  return (
    <Panel
      title="Lead capture"
      what={
        <>
          Runs Apify actors on a schedule and files what they find into the pipeline. Actor runs cost money on your Apify account,
          so every source caps how many rows it will take.
        </>
      }
      where={
        !apify.token && (
          <>
            Get a token at{" "}
            <a
              className="text-bronze hover:underline"
              href="https://console.apify.com/settings/integrations"
              target="_blank"
              rel="noreferrer"
            >
              console.apify.com → Settings → API &amp; Integrations
            </a>
            . It's verified against Apify before it's saved.
          </>
        )
      }
      state={
        apify.connected ? (
          <Connected>
            <span>
              {apify.account?.username ?? "your account"}
              {apify.account?.plan?.id && <span className="text-ink/50"> · {apify.account.plan.id} plan</span>}
            </span>
            <span className="font-mono text-xs text-ink/50">{apify.token}</span>
            {!apify.envManaged && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (confirm("Disconnect Apify? Scheduled runs stop until a token is added again.")) disconnect.mutate();
                }}
                disabled={disconnect.isPending}
              >
                Disconnect
              </Button>
            )}
          </Connected>
        ) : apify.error ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge tone="muted">error</Badge>
            <span className="text-red-600">{apify.error}</span>
          </div>
        ) : (
          <NotConnected>Scrapers can't run until a token is added.</NotConnected>
        )
      }
    >
      {apify.envManaged ? (
        <EnvNote variable="APIFY_TOKEN" />
      ) : (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (token.trim()) connect.mutate();
          }}
        >
          <div className="min-w-[22rem] flex-1">
            <Field label={apify.token ? "Replace token" : "Apify API token"}>
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="apify_api_…"
                autoComplete="off"
                className="input font-mono text-xs"
              />
            </Field>
          </div>
          <Button type="submit" disabled={connect.isPending || token.trim().length < 10}>
            {connect.isPending ? "Checking…" : "Save token"}
          </Button>
        </form>
      )}
      <ErrorNote error={connect.error ?? disconnect.error} />
    </Panel>
  );
}

// --- Payments --------------------------------------------------------------

function PaymentsPanel({ settings }: { settings: AppSettings }) {
  const save = useSaveSettings();
  const [secretKey, setSecretKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [copied, setCopied] = useState(false);

  const connect = useMutation({
    mutationFn: () => api.put<AppSettings>("/settings/stripe", { secretKey, webhookSecret: webhookSecret || undefined }),
    onSuccess: (result) => {
      setSecretKey("");
      setWebhookSecret("");
      save(result);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete<AppSettings>("/settings/stripe"),
    onSuccess: save,
  });

  const stripe = settings.stripe;

  return (
    <Panel
      title="Payments"
      what={
        <>
          Turns “Create payment link” on an invoice into a real Stripe Checkout session, and marks the invoice paid when Stripe says
          it was. Without it, that button returns a clear error instead of failing quietly.
        </>
      }
      where={
        !stripe.configured && (
          <>
            Secret key from{" "}
            <a className="text-bronze hover:underline" href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noreferrer">
              dashboard.stripe.com → Developers → API keys
            </a>
            . Use a <code className="font-mono text-xs">sk_test_…</code> key until you're ready to take real money.
          </>
        )
      }
      state={
        stripe.configured ? (
          <Connected>
            <span className="font-mono text-xs text-ink/50">{stripe.key}</span>
            <Badge tone={stripe.livemode ? "gold" : "muted"}>{stripe.livemode ? "live mode" : "test mode"}</Badge>
            {!stripe.webhookConfigured && <span className="text-xs text-amber-700">No webhook secret — invoices won't self-mark paid</span>}
            {!stripe.envManaged && (
              <Button variant="ghost" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Remove keys
              </Button>
            )}
          </Connected>
        ) : (
          <NotConnected>Payment links are disabled.</NotConnected>
        )
      }
    >
      <div className="mt-5">
        <Field
          label="Webhook endpoint"
          hint="In Stripe: Developers → Webhooks → Add endpoint, listening for checkout.session.completed. Then paste its signing secret below."
        >
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all border border-ink/10 bg-ivory px-2 py-1.5 text-xs">{stripe.webhookUrl}</code>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(stripe.webhookUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </Field>
      </div>

      {stripe.envManaged ? (
        <EnvNote variable="STRIPE_SECRET_KEY" />
      ) : (
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (secretKey.trim()) connect.mutate();
          }}
        >
          <Field label={stripe.configured ? "Replace secret key" : "Secret key"}>
            <input
              type="password"
              value={secretKey}
              onChange={(event) => setSecretKey(event.target.value)}
              placeholder="sk_test_…"
              autoComplete="off"
              className="input font-mono text-xs"
            />
          </Field>
          <Field label="Webhook signing secret" hint="Optional, but invoices won't mark themselves paid without it.">
            <input
              type="password"
              value={webhookSecret}
              onChange={(event) => setWebhookSecret(event.target.value)}
              placeholder="whsec_…"
              autoComplete="off"
              className="input font-mono text-xs"
            />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={connect.isPending || secretKey.trim().length < 10}>
              {connect.isPending ? "Checking…" : "Save keys"}
            </Button>
          </div>
        </form>
      )}
      <ErrorNote error={connect.error ?? remove.error} />
    </Panel>
  );
}

// --- File storage ----------------------------------------------------------

function StoragePanel({ settings }: { settings: AppSettings }) {
  const save = useSaveSettings();
  const [cloudName, setCloudName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");

  const connect = useMutation({
    mutationFn: () => api.put<AppSettings>("/settings/cloudinary", { cloudName, apiKey, apiSecret }),
    onSuccess: (result) => {
      setApiSecret("");
      save(result);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete<AppSettings>("/settings/cloudinary"),
    onSuccess: save,
  });

  const cloudinary = settings.cloudinary;

  return (
    <Panel
      title="File storage"
      what={
        <>
          Where generated proposal and invoice PDFs are stored, so they get a permanent link that can be sent to a client. Without
          it, “Generate PDF” still works — it streams the PDF straight to your browser instead of saving a URL.
        </>
      }
      where={
        !cloudinary.configured && (
          <>
            All three values are on the{" "}
            <a className="text-bronze hover:underline" href="https://console.cloudinary.com" target="_blank" rel="noreferrer">
              Cloudinary dashboard
            </a>{" "}
            under Product Environment Credentials.
          </>
        )
      }
      state={
        cloudinary.configured ? (
          <Connected>
            <span>{cloudinary.cloudName}</span>
            <span className="font-mono text-xs text-ink/50">{cloudinary.apiKey}</span>
            {!cloudinary.envManaged && (
              <Button variant="ghost" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Remove
              </Button>
            )}
          </Connected>
        ) : (
          <NotConnected>PDFs download instead of being stored.</NotConnected>
        )
      }
    >
      {cloudinary.envManaged ? (
        <EnvNote variable="CLOUDINARY_CLOUD_NAME" />
      ) : (
        <form
          className="mt-4 grid gap-3 sm:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (cloudName.trim() && apiKey.trim() && apiSecret.trim()) connect.mutate();
          }}
        >
          <Field label="Cloud name">
            <input
              value={cloudName}
              onChange={(event) => setCloudName(event.target.value)}
              placeholder={cloudinary.cloudName ?? "dakyworld"}
              className="input"
            />
          </Field>
          <Field label="API key">
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
              className="input font-mono text-xs"
            />
          </Field>
          <Field label="API secret">
            <input
              type="password"
              value={apiSecret}
              onChange={(event) => setApiSecret(event.target.value)}
              autoComplete="off"
              className="input font-mono text-xs"
            />
          </Field>
          <div className="sm:col-span-3">
            <Button type="submit" disabled={connect.isPending}>
              {connect.isPending ? "Saving…" : "Save credentials"}
            </Button>
          </div>
        </form>
      )}
      <ErrorNote error={connect.error ?? remove.error} />
    </Panel>
  );
}

// --- General ---------------------------------------------------------------

const TIMEZONES = ["Africa/Accra", "Africa/Lagos", "Europe/London", "America/New_York", "UTC"];

function GeneralPanel({ settings }: { settings: AppSettings }) {
  const save = useSaveSettings();
  const [appUrl, setAppUrl] = useState(settings.general.appUrl ?? "");
  const [timezone, setTimezone] = useState(settings.general.timezone);

  const update = useMutation({
    mutationFn: () => api.put<AppSettings>("/settings/general", { appUrl, timezone }),
    onSuccess: save,
  });

  const dirty = appUrl !== (settings.general.appUrl ?? "") || timezone !== settings.general.timezone;

  return (
    <Panel
      title="General"
      what="How the app describes itself to the outside world, and the defaults it starts new things with."
      state={
        <div className="text-sm text-ink/60">
          Currently answering as <code className="font-mono text-xs">{settings.general.resolvedAppUrl}</code>
        </div>
      }
    >
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field
          label="Public app URL"
          hint="Used to build the Google redirect URI and the Stripe webhook URL. Leave blank to use whatever host the request arrived on."
        >
          <input
            value={appUrl}
            onChange={(event) => setAppUrl(event.target.value)}
            placeholder="https://os.dakyworld.com"
            disabled={settings.general.appUrlEnvManaged}
            className="input"
          />
        </Field>
        <Field label="Default timezone" hint="Offered when scheduling a new scraper.">
          <select value={timezone} onChange={(event) => setTimezone(event.target.value)} className="input">
            {[...new Set([timezone, ...TIMEZONES])].map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {settings.general.appUrlEnvManaged && <EnvNote variable="APP_URL" />}
      <div className="mt-4">
        <Button onClick={() => update.mutate()} disabled={!dirty || update.isPending}>
          {update.isPending ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </Button>
      </div>
      <ErrorNote error={update.error} />
    </Panel>
  );
}
