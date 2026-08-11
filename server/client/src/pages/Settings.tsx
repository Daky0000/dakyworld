import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import type { ActorHealthReport, AppSettings, CaptureConfig } from "../lib/types";
import { Badge, Button, Field, PageHeader, StatusDot, Toggle } from "../components/ui";

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

type SectionId = "email" | "analyst" | "google" | "capture" | "payments" | "storage" | "general";

const SECTIONS: { id: SectionId; label: string; blurb: string }[] = [
  { id: "email", label: "Email", blurb: "The mailbox everything sends from" },
  { id: "analyst", label: "AI analyst", blurb: "Reads sheets, drafts emails" },
  { id: "google", label: "Google Drive", blurb: "Import a sheet without downloading it" },
  { id: "capture", label: "Lead capture", blurb: "Apify scrapers and their schedule" },
  { id: "payments", label: "Payments", blurb: "Stripe checkout links on invoices" },
  { id: "storage", label: "File storage", blurb: "Where generated PDFs are kept" },
  { id: "general", label: "General", blurb: "Public URL and default timezone" },
];

export function Settings() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [section, setSection] = useState<SectionId>((searchParams.get("tab") as SectionId) || "email");

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
      case "email":
        return data.email.configured ? "ok" : "idle";
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
              {section === "email" && <EmailPanel settings={data} />}
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

// --- Email -----------------------------------------------------------------

/**
 * The mailbox. SMTP rather than a provider API because every address Dakyworld
 * might send from already speaks it — no new account, no domain to verify
 * again before the first email can go out.
 */
function EmailPanel({ settings }: { settings: AppSettings }) {
  const email = settings.email;
  const save = useSaveSettings();
  const [host, setHost] = useState(email.host ?? "");
  const [port, setPort] = useState(email.port || 587);
  const [user, setUser] = useState(email.user ?? "");
  const [password, setPassword] = useState("");
  const [fromName, setFromName] = useState(email.fromName ?? "Dan Kwame Ayipah");
  const [fromEmail, setFromEmail] = useState(email.fromEmail ?? "");
  const [replyTo, setReplyTo] = useState(email.replyTo ?? "");
  const [sign, setSign] = useState(email.signature ?? "");
  const [testTo, setTestTo] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);

  const connect = useMutation({
    mutationFn: () =>
      api.put<AppSettings>("/settings/email", {
        host: host.trim(),
        port: Number(port),
        user: user.trim(),
        password,
        fromName: fromName.trim(),
        fromEmail: fromEmail.trim(),
        replyTo: replyTo.trim(),
        signature: sign,
      }),
    onSuccess: (result) => {
      save(result);
      setPassword("");
    },
  });
  const remove = useMutation({ mutationFn: () => api.delete<AppSettings>("/settings/email"), onSuccess: save });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; to: string }>("/settings/email/test", { to: testTo.trim() }),
    onSuccess: (result) => setTestResult(`Sent to ${result.to}. If it doesn't arrive, check the spam folder before anything else.`),
    onError: (err: Error) => setTestResult(err.message),
  });

  /** The three mailboxes Dakyworld realistically sends from, pre-filled. */
  const presets = [
    { label: "Google Workspace", host: "smtp.gmail.com", port: 587, note: "Use an App Password, not the account password." },
    { label: "Hostinger", host: "smtp.hostinger.com", port: 465, note: "The mailbox password, as set in hPanel." },
    { label: "Zoho Mail", host: "smtp.zoho.com", port: 465, note: "An app-specific password if 2FA is on." },
  ];

  return (
    <Panel
      title="Email"
      what={
        <>
          The address the whole system sends from — proposals, invoices, deliverables, cold outreach and every follow-up sequence.
          Nothing leaves the app until this is connected.
        </>
      }
      where={
        !email.configured && (
          <>
            Any mailbox with SMTP works. On Google Workspace you need an{" "}
            <a
              className="text-bronze hover:underline"
              href="https://myaccount.google.com/apppasswords"
              target="_blank"
              rel="noreferrer"
            >
              App Password
            </a>{" "}
            rather than the account password — Google refuses plain logins from applications.
          </>
        )
      }
      state={
        email.configured ? (
          <Connected>
            <span>
              {email.fromName} &lt;{email.fromEmail}&gt;
            </span>
            <span className="font-mono text-xs text-ink/50">
              {email.host}:{email.port}
            </span>
            {!email.envManaged && (
              <Button variant="ghost" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Disconnect
              </Button>
            )}
          </Connected>
        ) : (
          <NotConnected>Emails can be written and queued, but none will send.</NotConnected>
        )
      }
    >
      {email.envManaged ? (
        <EnvNote variable="SMTP_HOST" />
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            {presets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                title={preset.note}
                onClick={() => {
                  setHost(preset.host);
                  setPort(preset.port);
                }}
                className="border border-ink/15 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[.1em] text-ink/55 transition hover:border-ink hover:text-ink"
              >
                {preset.label}
              </button>
            ))}
          </div>

          <form
            className="mt-4 grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (host.trim() && user.trim() && password && fromEmail.trim()) connect.mutate();
            }}
          >
            <Field label="SMTP host">
              <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="smtp.gmail.com" className="input" />
            </Field>
            <Field label="Port" hint="587 for STARTTLS, 465 for implicit TLS.">
              <input type="number" value={port} onChange={(event) => setPort(Number(event.target.value))} className="input" />
            </Field>
            <Field label="Username">
              <input value={user} onChange={(event) => setUser(event.target.value)} placeholder="dan@dakyworld.com" className="input" />
            </Field>
            <Field label="Password" hint="Stored encrypted. Never shown again.">
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={email.configured ? "•••••••• (unchanged)" : "App password"}
                className="input"
              />
            </Field>
            <Field label="From name">
              <input value={fromName} onChange={(event) => setFromName(event.target.value)} className="input" />
            </Field>
            <Field label="From address">
              <input value={fromEmail} onChange={(event) => setFromEmail(event.target.value)} placeholder="dan@dakyworld.com" className="input" />
            </Field>
            <Field label="Reply-to" hint="Optional — where replies should land, if not the from address." full>
              <input value={replyTo} onChange={(event) => setReplyTo(event.target.value)} className="input" />
            </Field>
            <Field label="Signature" hint="Appended to every email the app sends." full>
              <textarea rows={3} value={sign} onChange={(event) => setSign(event.target.value)} className="input" />
            </Field>

            <div className="sm:col-span-2 flex items-center gap-3">
              <Button type="submit" disabled={connect.isPending || !host.trim() || !user.trim() || !password || !fromEmail.trim()}>
                {connect.isPending ? "Checking with the server…" : email.configured ? "Save" : "Connect"}
              </Button>
              <span className="text-xs text-ink/45">Checked against the mail server before it's saved.</span>
            </div>
          </form>
          <ErrorNote error={connect.error} />
        </>
      )}

      {email.configured && (
        <div className="mt-6 border-t border-ink/10 pt-4">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">Send a test</div>
          <div className="flex flex-wrap gap-2">
            <input
              className="input max-w-xs"
              placeholder="your@address.com"
              value={testTo}
              onChange={(event) => setTestTo(event.target.value)}
            />
            <Button variant="secondary" onClick={() => test.mutate()} disabled={test.isPending || !/^\S+@\S+\.\S+$/.test(testTo)}>
              {test.isPending ? "Sending…" : "Send test"}
            </Button>
          </div>
          {testResult && <p className="mt-2 text-sm text-ink/60">{testResult}</p>}
        </div>
      )}
    </Panel>
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

      <CaptureBehaviour settings={settings} />
      <ActorHealthList />
    </Panel>
  );
}

/** This month's Apify spend against whatever ceiling it has. */
function SpendMeter({ settings }: { settings: AppSettings }) {
  const usage = settings.apify.usage;
  if (!usage) return null;

  const budget = settings.capture.config.monthlyBudgetUsd;
  const ceiling = budget ?? usage.includedUsd;
  const fraction = ceiling && ceiling > 0 ? Math.min(1, usage.spentUsd / ceiling) : null;
  const blocked = budget != null && usage.spentUsd >= budget;

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className="font-medium">${usage.spentUsd.toFixed(2)}</span>
        <span className="text-ink/50">
          this billing month
          {ceiling ? ` of $${ceiling.toFixed(2)} ${budget != null ? "budget" : "included"}` : ""}
        </span>
        {blocked && <Badge tone="muted">runs paused</Badge>}
      </div>
      {fraction != null && (
        <div className="mt-1.5 h-1 w-full max-w-sm bg-ink/10">
          <div
            className={`h-1 ${blocked ? "bg-red-500" : fraction > 0.8 ? "bg-amber-500" : "bg-ink"}`}
            style={{ width: `${Math.max(2, fraction * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

// --- Capture behaviour -----------------------------------------------------

const CAPTURE_TIMEZONES = ["Africa/Accra", "Africa/Lagos", "Africa/Nairobi", "Africa/Johannesburg", "Europe/London", "UTC"];

const PROXY_LABELS: Record<CaptureConfig["proxyMode"], string> = {
  NONE: "No proxy — cheapest, blocked most often",
  AUTO: "Apify proxy, automatic group (recommended)",
  DATACENTER: "Datacenter — fast and cheap",
  RESIDENTIAL: "Residential — dearest, hardest to block",
};

const NOTIFY_LABELS: Record<CaptureConfig["notify"], string> = {
  OFF: "Never email me",
  FAILURES: "Only when something goes wrong or a run finds nothing",
  ALL: "After every run",
};

/**
 * The half of lead capture that isn't the token: the market being searched,
 * what a run may cost, what a new source starts as, and who hears about it.
 *
 * One form, one save. Each of these is a global default rather than a
 * per-source setting precisely because keeping ten sources in step by hand is
 * how they end up out of step.
 */
function CaptureBehaviour({ settings }: { settings: AppSettings }) {
  const save = useSaveSettings();
  const qc = useQueryClient();
  const saved = settings.capture.config;
  const env = settings.capture.envManaged;
  const [form, setForm] = useState<CaptureConfig>(saved);

  // Reset the draft when the *saved values* change, not when the settings
  // object is merely re-fetched — a background refetch on window focus would
  // otherwise throw away whatever was being typed.
  const savedKey = JSON.stringify(saved);
  useEffect(() => setForm(JSON.parse(savedKey) as CaptureConfig), [savedKey]);

  const update = useMutation({
    mutationFn: () => api.put<AppSettings>("/settings/capture", form),
    onSuccess: (result) => {
      save(result);
      void qc.invalidateQueries({ queryKey: ["scraper-overview"] });
      void qc.invalidateQueries({ queryKey: ["scraper-sources"] });
    },
  });

  const set = <K extends keyof CaptureConfig>(key: K, value: CaptureConfig[K]) => setForm({ ...form, [key]: value });
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);

  return (
    <div className="mt-8 border-t border-ink/10 pt-6">
      <SpendMeter settings={settings} />

      <div className="mt-6 space-y-6">
        <Group
          title="The market"
          blurb={
            <>
              Where the searches look. Any source whose actor input contains{" "}
              <code className="font-mono text-xs">{"{{location}}"}</code>,{" "}
              <code className="font-mono text-xs">{"{{country}}"}</code> or{" "}
              <code className="font-mono text-xs">{"{{language}}"}</code> follows this — so widening the market is one
              change here, not ten edits across sources.
            </>
          }
        >
          <Field label="Search location" hint="Exactly as you'd type it into Google Maps.">
            <input value={form.location} onChange={(event) => set("location", event.target.value)} className="input" />
          </Field>
          <Field label="Country code" hint="Two letters, e.g. gh.">
            <input
              value={form.countryCode}
              onChange={(event) => set("countryCode", event.target.value.toLowerCase())}
              maxLength={2}
              className="input font-mono text-xs"
            />
          </Field>
          <Field label="Results language">
            <input value={form.language} onChange={(event) => set("language", event.target.value)} className="input" />
          </Field>
        </Group>

        <Group
          title="What a run may cost"
          blurb="Apify bills per run. These are the limits that stop one bad input JSON spending a month's credits overnight — a run refused here costs nothing."
        >
          <Field
            label="Monthly budget (USD)"
            hint={env.monthlyBudgetUsd ? "Pinned by the deploy." : "Blank means no ceiling. Runs are refused once the month's spend reaches it."}
          >
            <input
              type="number"
              min={0}
              step="0.01"
              value={form.monthlyBudgetUsd ?? ""}
              disabled={env.monthlyBudgetUsd}
              onChange={(event) => set("monthlyBudgetUsd", event.target.value === "" ? null : Number(event.target.value))}
              placeholder="No ceiling"
              className="input disabled:opacity-40"
            />
          </Field>
          <Field
            label="Max charge per run (USD)"
            hint="Apify stops a pay-per-event actor once a run reaches this. Blank means only the monthly budget applies."
          >
            <input
              type="number"
              min={0}
              step="0.01"
              value={form.maxRunChargeUsd ?? ""}
              onChange={(event) => set("maxRunChargeUsd", event.target.value === "" ? null : Number(event.target.value))}
              placeholder="No cap"
              className="input"
            />
          </Field>
          <Field label="Runs at once" hint={env.maxConcurrentRuns ? "Pinned by the deploy." : "Scrapes are slow; more at once mostly means more spent at once."}>
            <input
              type="number"
              min={1}
              max={10}
              value={form.maxConcurrentRuns}
              disabled={env.maxConcurrentRuns}
              onChange={(event) => set("maxConcurrentRuns", Number(event.target.value))}
              className="input disabled:opacity-40"
            />
          </Field>
          <Field label="Run timeout (minutes)" hint="Actors ship defaults measured in days. This is the one that matters.">
            <input
              type="number"
              min={1}
              max={360}
              value={Math.round(form.runTimeoutSecs / 60)}
              onChange={(event) => set("runTimeoutSecs", Math.max(60, Number(event.target.value) * 60))}
              className="input"
            />
          </Field>
          <Field label="Memory per run" hint="Leave on the actor's own default unless a run reports running out.">
            <select
              value={form.memoryMbytes}
              onChange={(event) => set("memoryMbytes", Number(event.target.value))}
              className="input"
            >
              <option value={0}>Actor's default</option>
              <option value={1024}>1 GB</option>
              <option value={2048}>2 GB</option>
              <option value={4096}>4 GB</option>
              <option value={8192}>8 GB</option>
            </select>
          </Field>
          <Field
            label="Proxy"
            hint="Only used by actors that take one — the Google Maps actors handle their own."
            full
          >
            <select
              value={form.proxyMode}
              onChange={(event) => set("proxyMode", event.target.value as CaptureConfig["proxyMode"])}
              className="input"
            >
              {(Object.keys(PROXY_LABELS) as CaptureConfig["proxyMode"][]).map((mode) => (
                <option key={mode} value={mode}>
                  {PROXY_LABELS[mode]}
                </option>
              ))}
            </select>
          </Field>
          {form.proxyMode === "RESIDENTIAL" && (
            <Field label="Proxy country" hint="Two letters, e.g. GH. Blank lets Apify choose.">
              <input
                value={form.proxyCountry ?? ""}
                onChange={(event) => set("proxyCountry", event.target.value.toUpperCase() || null)}
                maxLength={2}
                className="input font-mono text-xs"
              />
            </Field>
          )}
        </Group>

        <Group
          title="What a new source starts as"
          blurb="Filled in when a source is added, and editable per source afterwards. Changing these doesn't touch sources that already exist."
        >
          <Field label="Max leads per run">
            <input
              type="number"
              min={1}
              max={1000}
              value={form.maxItems}
              onChange={(event) => set("maxItems", Number(event.target.value))}
              className="input"
            />
          </Field>
          <Field label="Minimum score to keep" hint="Below this a row is dropped rather than filed.">
            <input
              type="number"
              min={0}
              max={100}
              value={form.minScore}
              onChange={(event) => set("minScore", Number(event.target.value))}
              className="input"
            />
          </Field>
          <Field label="Auto-qualify above" hint="Straight to QUALIFYING instead of NEW.">
            <input
              type="number"
              min={0}
              max={100}
              value={form.qualifyScore}
              disabled={!form.autoQualify}
              onChange={(event) => set("qualifyScore", Number(event.target.value))}
              className="input disabled:opacity-40"
            />
          </Field>
          <Field label="Schedule timezone" hint={env.timezone ? "Pinned by the deploy." : undefined}>
            <select
              value={form.timezone}
              disabled={env.timezone}
              onChange={(event) => set("timezone", event.target.value)}
              className="input disabled:opacity-40"
            >
              {[...new Set([form.timezone, ...CAPTURE_TIMEZONES])].map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Toggle
              checked={form.autoQualify}
              onChange={(next) => set("autoQualify", next)}
              label="Auto-qualify strong leads"
            />
          </div>
        </Group>

        <Group
          title="Being told about it"
          blurb="Scrapes run at whatever hour the schedule says. A run that fails and a run that quietly files nothing look identical from the Leads page — an empty morning."
        >
          <Field label="Email me" full>
            <select
              value={form.notify}
              onChange={(event) => set("notify", event.target.value as CaptureConfig["notify"])}
              className="input"
            >
              {(Object.keys(NOTIFY_LABELS) as CaptureConfig["notify"][]).map((mode) => (
                <option key={mode} value={mode}>
                  {NOTIFY_LABELS[mode]}
                </option>
              ))}
            </select>
          </Field>
          {form.notify !== "OFF" && (
            <Field label="Send reports to" hint={`Blank uses ${settings.email.fromEmail ?? "the address the app sends from"}.`}>
              <input
                type="email"
                value={form.notifyEmail ?? ""}
                onChange={(event) => set("notifyEmail", event.target.value || null)}
                placeholder={settings.email.fromEmail ?? "you@dakyworld.com"}
                className="input"
              />
            </Field>
          )}
          <Field label="Keep run history for (days)" hint="0 keeps everything. Captured leads are never deleted.">
            <input
              type="number"
              min={0}
              max={3650}
              value={form.retentionDays}
              onChange={(event) => set("retentionDays", Number(event.target.value))}
              className="input"
            />
          </Field>
        </Group>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button onClick={() => update.mutate()} disabled={!dirty || update.isPending}>
          {update.isPending ? "Saving…" : dirty ? "Save capture settings" : "Saved"}
        </Button>
        {dirty && (
          <button type="button" onClick={() => setForm(saved)} className="font-mono text-[11px] uppercase tracking-[.12em] text-ink/40">
            Discard
          </button>
        )}
        {!dirty && (
          <button
            type="button"
            onClick={() => setForm(settings.capture.defaults)}
            className="font-mono text-[11px] uppercase tracking-[.12em] text-ink/40"
          >
            Reset to defaults
          </button>
        )}
      </div>
      <ErrorNote error={update.error} />
    </div>
  );
}

function Group({ title, blurb, children }: { title: string; blurb: ReactNode; children: ReactNode }) {
  return (
    <section className="border border-ink/10 bg-ivory/40 p-4">
      <h3 className="font-mono text-[10px] uppercase tracking-[.16em] text-ink/50">{title}</h3>
      <p className="mt-1 max-w-2xl text-xs text-ink/50">{blurb}</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

// --- Actor health ----------------------------------------------------------

const PRICING_LABELS: Record<string, string> = {
  FREE: "free",
  FLAT_PRICE_PER_MONTH: "monthly rental",
  PRICE_PER_DATASET_ITEM: "per result",
  PAY_PER_EVENT: "per event",
};

/**
 * An actor is someone else's code on someone else's account: it gets renamed,
 * made private or repriced, and the first sign is a scheduled run failing at
 * 06:00. This asks Apify now instead.
 */
function ActorHealthList() {
  // Bumping this changes the query key, which is what re-runs the check —
  // and past zero it also tells the server to ignore its schema cache.
  const [refreshed, setRefreshed] = useState(0);
  const { data, isFetching } = useQuery({
    queryKey: ["actor-health", refreshed],
    queryFn: () => api.get<ActorHealthReport>(`/scrapers/actors${refreshed ? "?refresh=1" : ""}`),
  });

  return (
    <div className="mt-8 border-t border-ink/10 pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-mono text-[10px] uppercase tracking-[.16em] text-ink/50">Actors in use</h3>
          <p className="mt-1 max-w-2xl text-xs text-ink/50">
            Every actor the templates and your sources point at, checked against Apify.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setRefreshed((n) => n + 1)} disabled={isFetching}>
          {isFetching ? "Checking…" : "Re-check"}
        </Button>
      </div>

      <div className="mt-4 grid gap-2">
        {data?.actors.map((actor) => {
          const problems = actor.usedBy.filter((source) => source.unknownKeys.length > 0);
          return (
            <div key={actor.actorId} className="border border-ink/10 bg-white px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <StatusDot tone={!actor.reachable ? "bad" : problems.length ? "warn" : "ok"} />
                <a
                  href={`https://apify.com/${actor.actorId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs hover:text-bronze hover:underline"
                >
                  {actor.actorId} ↗
                </a>
                {actor.pricingModel && <Badge tone="muted">{PRICING_LABELS[actor.pricingModel] ?? actor.pricingModel}</Badge>}
                {actor.proxyRequired && <Badge tone="muted">needs a proxy</Badge>}
                {actor.inTemplates && actor.usedBy.length === 0 && <span className="text-xs text-ink/40">template only</span>}
                {actor.usedBy.length > 0 && (
                  <span className="text-xs text-ink/50">
                    used by {actor.usedBy.map((source) => source.name).join(", ")}
                  </span>
                )}
              </div>
              {!actor.reachable && (
                <p className="mt-1.5 text-xs text-red-600">
                  Apify wouldn't return this actor — it may have been renamed, made private, or removed. Any source pointing at
                  it will fail on its next run.
                </p>
              )}
              {problems.map((source) => (
                <p key={source.id} className="mt-1.5 text-xs text-amber-700">
                  <strong>{source.name}</strong> sends {source.unknownKeys.map((key) => `“${key}”`).join(", ")}, which this
                  actor doesn't accept — Apify ignores those silently, so the setting isn't doing anything.
                </p>
              ))}
            </div>
          );
        })}
        {data?.actors.length === 0 && <p className="text-sm text-ink/50">No actors configured yet.</p>}
      </div>
    </div>
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
