import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { AgentReposPanel, HubtelPanel, PaystackPanel } from "../components/GhanaPayments";
import { SmsCallbackPanel, WhatsAppPanel } from "../components/MessagingSettings";
import type {
  ActorHealthReport,
  AppSettings,
  BrandSlot,
  CaptureConfig,
  CompanyProfile,
  ModelJob,
  ModelJobInfo,
  ModelProvider,
  ModelRoute,
  InboxSuggestion,
} from "../lib/types";
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

type SectionId =
  | "security"
  | "system"
  | "email"
  | "messaging"
  | "analyst"
  | "models"
  | "google"
  | "capture"
  | "payments"
  | "storage"
  | "alerts"
  | "developer"
  | "webhooks"
  | "general";

const SECTIONS: { id: SectionId; label: string; blurb: string }[] = [
  { id: "security", label: "Security", blurb: "Your password and two-factor" },
  { id: "system", label: "System", blurb: "Your name, address, phone and logo" },
  { id: "email", label: "Email", blurb: "The mailbox everything sends from, and is read from" },
  { id: "messaging", label: "Messaging", blurb: "WhatsApp and SMS, for leads with no email" },
  { id: "analyst", label: "AI analyst", blurb: "Reads sheets, runs the agents" },
  { id: "models", label: "AI models", blurb: "Who writes, draws and checks facts" },
  { id: "google", label: "Google", blurb: "Drive imports and the calendar" },
  { id: "capture", label: "Lead capture", blurb: "Apify scrapers and their schedule" },
  { id: "payments", label: "Payments", blurb: "Paystack, Hubtel mobile money, Stripe" },
  { id: "storage", label: "File storage", blurb: "Where generated PDFs are kept" },
  { id: "alerts", label: "Alerts", blurb: "Slack, for anything worth interrupting you" },
  { id: "developer", label: "Developer", blurb: "GitHub, for the technical agents" },
  { id: "webhooks", label: "Webhooks", blurb: "Events in from the website and partners" },
  { id: "general", label: "General", blurb: "Public URL and default timezone" },
];

export function Settings() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [section, setSection] = useState<SectionId>((searchParams.get("tab") as SectionId) || "system");

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
      // Green only when every job is served by the vendor chosen for it.
      // Amber while something is falling back — the work still happens, but not
      // where the Owner asked for it.
      case "models":
        return data.models.routing.every((route) => route.ready)
          ? "ok"
          : data.models.providers.some((provider) => provider.key !== "anthropic" && provider.configured)
            ? "warn"
            : "idle";
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
      // Amber for a connected WhatsApp whose webhook is not verified: it can
      // send perfectly well and cannot hear a word back, which is the state
      // most likely to be mistaken for working.
      case "messaging":
        return data.messaging.whatsapp.configured
          ? data.messaging.whatsapp.inboundTrusted
            ? "ok"
            : "warn"
          : "idle";
      case "alerts":
        return data.alerts.configured ? "ok" : "idle";
      case "developer":
        return data.developer.configured ? "ok" : "idle";
      // Always available — the secret mints itself, so there is nothing to
      // wait on and a warning dot here would be permanent noise.
      case "webhooks":
        return "ok";
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
        <nav className="h-fit rounded-2xl border border-line bg-white">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => choose(entry.id)}
              className={`flex w-full items-start gap-3 border-b border-ink/5 px-4 py-3 text-left transition last:border-0 ${
                section === entry.id ? "bg-ink text-cream" : "hover:bg-cream"
              }`}
            >
              <span className="mt-1.5">
                <StatusDot tone={status(entry.id)} />
              </span>
              <span className="min-w-0">
                <span className="block font-mono text-[11px] uppercase tracking-[.12em]">{entry.label}</span>
                <span className={`mt-0.5 block text-xs ${section === entry.id ? "text-cream/60" : "text-ink/45"}`}>
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
              {section === "security" && <SecurityPanel />}
              {section === "system" && <SystemPanel settings={data} />}
              {section === "email" && (
                <>
                  <EmailPanel settings={data} />
                  <InboxPanel settings={data} />
                </>
              )}
              {section === "analyst" && <AnalystPanel settings={data} />}
              {section === "models" && <ModelsPanel settings={data} />}
              {section === "google" && <GooglePanel settings={data} result={googleResult} params={searchParams} />}
              {section === "capture" && <CapturePanel settings={data} />}
              {section === "payments" && (
                <div className="space-y-6">
                  {/* The Ghanaian rails first: they are the ones that make a GHS
                      invoice payable, and Stripe is here for anything abroad. */}
                  <PaystackPanel settings={data} />
                  <HubtelPanel settings={data} />
                  <PaymentsPanel settings={data} />
                </div>
              )}
              {section === "messaging" && (
                <div className="space-y-6">
                  <WhatsAppPanel settings={data} />
                  <SmsCallbackPanel settings={data} />
                </div>
              )}
              {section === "storage" && <StoragePanel settings={data} />}
              {section === "alerts" && <AlertsPanel settings={data} />}
              {section === "developer" && (
                <div className="space-y-6">
                  <DeveloperPanel settings={data} />
                  <AgentReposPanel settings={data} />
                </div>
              )}
              {section === "webhooks" && <WebhooksPanel settings={data} />}
              {section === "general" && <GeneralPanel settings={data} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// --- System ----------------------------------------------------------------

/**
 * The company's own details, in the one place they are held.
 *
 * These used to be constants in the server's `services/dakyworld.ts` — correct
 * and single-sourced, and changeable only by a developer with a deploy. This
 * is the same single source, made editable. What is typed here is what appears
 * on the email letterhead, on every PDF, in the Word cut of a proposal, in the
 * plain-text footer, on the unsubscribe page, and in the brief the AI drafter
 * and the proposal writer are given. Nothing has a second copy.
 *
 * **Blank is not empty.** A field left blank falls back to the shipped default
 * rather than printing nothing, which is why every input shows that default as
 * placeholder text. The genuinely optional details — a second phone line, a
 * VAT number — have no default, so blank there means what it looks like.
 */
function SystemPanel({ settings }: { settings: AppSettings }) {
  const save = useSaveSettings();
  const [form, setForm] = useState<CompanyProfile>(settings.system.profile);
  const [address, setAddress] = useState(settings.system.profile.addressLines.join("\n"));

  // Reload the form when the snapshot changes underneath it — an upload
  // returns a fresh snapshot, and the fields must not revert to a stale copy.
  const [loadedFor, setLoadedFor] = useState(settings.system.profile);
  useEffect(() => {
    if (loadedFor === settings.system.profile) return;
    setLoadedFor(settings.system.profile);
    setForm(settings.system.profile);
    setAddress(settings.system.profile.addressLines.join("\n"));
  }, [settings.system.profile, loadedFor]);

  const update = useMutation({
    mutationFn: () =>
      api.put<AppSettings>("/settings/system", {
        ...form,
        addressLines: address.split("\n").map((line) => line.trim()).filter(Boolean),
      }),
    onSuccess: save,
  });

  const set = <K extends keyof CompanyProfile>(key: K, value: CompanyProfile[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const defaults = settings.system.defaults;
  const dirty =
    JSON.stringify({ ...form, addressLines: address.split("\n").map((l) => l.trim()).filter(Boolean) }) !==
    JSON.stringify(settings.system.profile);

  return (
    <div className="space-y-6">
      <Panel
        title="System"
        what="Who the business is, everywhere it says so. Change a detail here and it changes on every email, every PDF, every proposal and everything the AI writes — there is no second copy to keep in step."
        state={
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-ink/60">
            <span className="font-display text-lg tracking-[-.02em] text-ink">{settings.system.profile.displayName}</span>
            <span>{settings.system.profile.location}</span>
            <span>{settings.system.profile.email}</span>
            <span>{settings.system.profile.phone}</span>
          </div>
        }
      >
        <div className="mt-6 space-y-6">
          <Band title="Identity">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name in a sentence" hint="How the company is written in prose, and how emails sign off.">
                <input className="input" value={form.displayName} placeholder={defaults.displayName} onChange={(e) => set("displayName", e.target.value)} />
              </Field>
              <Field label="Printed name" hint="The letterspaced form on a letterhead. Usually the name in capitals.">
                <input className="input" value={form.name} placeholder={defaults.name} onChange={(e) => set("name", e.target.value)} />
              </Field>
              <Field label="Registered name" hint="The legal entity, for invoices and terms. Leave blank to use the name above.">
                <input className="input" value={form.legalName} placeholder={defaults.legalName} onChange={(e) => set("legalName", e.target.value)} />
              </Field>
              <Field label="Default currency" hint="What money is quoted in unless a record says otherwise.">
                <input className="input" value={form.currency} placeholder={defaults.currency} onChange={(e) => set("currency", e.target.value)} />
              </Field>
            </div>
          </Band>

          <Band title="What you say about yourself">
            <div className="space-y-4">
              <Field label="Positioning" full hint="The one sentence in the footer of every email and on the website.">
                <input className="input" value={form.positioning} placeholder={defaults.positioning} onChange={(e) => set("positioning", e.target.value)} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Tagline" hint="Set small and letterspaced under the logo on documents. Capitals.">
                  <input className="input" value={form.tagline} placeholder={defaults.tagline} onChange={(e) => set("tagline", e.target.value)} />
                </Field>
                <Field label="Footer line" hint="The short promise across the bottom of a page. Capitals.">
                  <input className="input" value={form.footerLine} placeholder={defaults.footerLine} onChange={(e) => set("footerLine", e.target.value)} />
                </Field>
              </div>
              <Field label="The same promise, in sentence case" full hint="Used in plain-text email, where capitals read as shouting.">
                <input className="input" value={form.promise} placeholder={defaults.promise} onChange={(e) => set("promise", e.target.value)} />
              </Field>
            </div>
          </Band>

          <Band title="How to reach you">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Email" hint="Shown on the letterhead and in the footer of every email.">
                <input className="input" value={form.email} placeholder={defaults.email} onChange={(e) => set("email", e.target.value)} />
              </Field>
              <Field label="Website" hint="Without https:// — it is added where a link is needed.">
                <input className="input" value={form.web} placeholder={defaults.web} onChange={(e) => set("web", e.target.value)} />
              </Field>
              <Field label="Phone" hint="The main line.">
                <input className="input" value={form.phone} placeholder={defaults.phone} onChange={(e) => set("phone", e.target.value)} />
              </Field>
              <Field label="Second line" hint="WhatsApp, a landline. Left blank it simply isn't printed.">
                <input className="input" value={form.phoneAlt} placeholder="optional" onChange={(e) => set("phoneAlt", e.target.value)} />
              </Field>
              <Field label="City and country" hint="The short location line beside the logo.">
                <input className="input" value={form.location} placeholder={defaults.location} onChange={(e) => set("location", e.target.value)} />
              </Field>
              <Field label="Postal address" hint="One line per line. Only used where a full address is needed.">
                <textarea rows={3} className="input" value={address} placeholder="optional" onChange={(e) => setAddress(e.target.value)} />
              </Field>
            </div>
          </Band>

          <Band title="Where you can be found">
            <div className="grid gap-4 sm:grid-cols-2">
              {(["linkedin", "x", "instagram", "facebook", "youtube"] as const).map((network) => (
                <Field key={network} label={SOCIAL_LABEL[network]} hint="A full URL. Blank ones are not shown.">
                  <input
                    className="input"
                    value={form.social[network]}
                    placeholder="optional"
                    onChange={(e) => set("social", { ...form.social, [network]: e.target.value })}
                  />
                </Field>
              ))}
            </div>
          </Band>

          <Band title="Registration">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Company number" hint="Printed in the legal line at the foot of an email.">
                <input className="input" value={form.registrationNumber} placeholder="optional" onChange={(e) => set("registrationNumber", e.target.value)} />
              </Field>
              <Field label="VAT number" hint="Printed on invoices where one exists.">
                <input className="input" value={form.vatNumber} placeholder="optional" onChange={(e) => set("vatNumber", e.target.value)} />
              </Field>
            </div>
          </Band>
        </div>

        <div className="mt-6 flex items-center gap-3">
          <Button onClick={() => update.mutate()} disabled={!dirty || update.isPending}>
            {update.isPending ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </Button>
          {dirty && <span className="text-xs text-ink/45">This changes every email, PDF and proposal from the next one onward.</span>}
        </div>
        <ErrorNote error={update.error} />
      </Panel>

      <BrandPanel settings={settings} />
    </div>
  );
}

/** A titled band inside the System form, which is long enough to need them. */
function Band({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 border-b border-ink/10 pb-1.5 font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">{title}</h3>
      {children}
    </section>
  );
}

const SOCIAL_LABEL: Record<string, string> = {
  linkedin: "LinkedIn",
  x: "X",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
};

/**
 * The artwork.
 *
 * Uploaded logos are held in the database rather than written to disk, because
 * Railway's filesystem is ephemeral — a file written at runtime survives until
 * the next deploy and then silently reverts, which is worse than not working
 * at all because it looks like it worked. Removing an upload falls the slot
 * back to the artwork shipped in `server/assets/`.
 */
function BrandPanel({ settings }: { settings: AppSettings }) {
  const save = useSaveSettings();
  const [busy, setBusy] = useState<BrandSlot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: ({ slot, dataUrl }: { slot: BrandSlot; dataUrl: string }) =>
      api.put<AppSettings>(`/settings/system/brand/${slot}`, { dataUrl }),
    onSuccess: save,
    onError: (err: Error) => setError(err.message),
    onSettled: () => setBusy(null),
  });

  const remove = useMutation({
    mutationFn: (slot: BrandSlot) => api.delete<AppSettings>(`/settings/system/brand/${slot}`),
    onSuccess: save,
    onError: (err: Error) => setError(err.message),
    onSettled: () => setBusy(null),
  });

  const pick = (slot: BrandSlot, file: File) => {
    setError(null);
    setBusy(slot);
    const reader = new FileReader();
    reader.onerror = () => {
      setError("That file could not be read.");
      setBusy(null);
    };
    reader.onload = () => upload.mutate({ slot, dataUrl: String(reader.result) });
    reader.readAsDataURL(file);
  };

  return (
    <Panel
      title="Logo and artwork"
      what="What is stamped on a document and embedded in an email. Logos are attached to the message itself rather than linked, so they show even in Outlook with images blocked."
      where="Under 1 MB each, PNG with a transparent background for preference. Anything left empty falls back to the artwork shipped with the app."
      state={
        <div className="text-sm text-ink/60">
          {settings.system.brand.filter((entry) => entry.uploaded).length} of {settings.system.brand.length} uploaded
        </div>
      }
    >
      {error && <p className="mt-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {settings.system.brand.map((entry) => {
          const image = settings.system.images[entry.slot];
          const onDark = entry.slot === "logoDark";
          return (
            <div key={entry.slot} className="rounded-2xl border border-line bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">{entry.label}</p>
                  <p className="mt-1 text-xs leading-relaxed text-ink/55">{entry.what}</p>
                </div>
                {entry.uploaded ? <Badge tone="positive">uploaded</Badge> : <Badge tone="muted">shipped</Badge>}
              </div>

              <div
                className={`mt-3 flex h-24 items-center justify-center rounded-xl border border-dashed border-ink/15 px-4 ${
                  onDark ? "bg-ink" : "bg-cream"
                }`}
              >
                {image ? (
                  <img src={image} alt={entry.label} className="max-h-16 max-w-full object-contain" />
                ) : (
                  <span className={`font-mono text-[10px] uppercase tracking-[.12em] ${onDark ? "text-cream/40" : "text-ink/30"}`}>
                    nothing uploaded
                  </span>
                )}
              </div>

              <div className="mt-3 flex items-center gap-2">
                <label className="cursor-pointer border border-ink/20 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[.1em] text-ink/60 transition hover:border-ink hover:text-ink">
                  {busy === entry.slot ? "Uploading…" : entry.uploaded ? "Replace" : "Upload"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) pick(entry.slot, file);
                      event.target.value = "";
                    }}
                  />
                </label>
                {entry.uploaded && (
                  <button
                    type="button"
                    onClick={() => {
                      setBusy(entry.slot);
                      remove.mutate(entry.slot);
                    }}
                    className="font-mono text-[10px] uppercase tracking-[.1em] text-ink/40 transition hover:text-ink"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// --- Email -----------------------------------------------------------------

/**
 * The mailbox, two ways.
 *
 * **Hostinger is one field.** The mailbox on the domain is Hostinger's, and
 * Hostinger gives it an MCP server, so connecting it needs an API token and
 * nothing else — the address it sends from is read back from Hostinger rather
 * than typed in. That is the difference between connecting mail in a minute and
 * hunting a wrong port for an evening, so it is the first chip.
 *
 * **Everything else is SMTP**, which every other mailbox already speaks.
 */
function EmailPanel({ settings }: { settings: AppSettings }) {
  const email = settings.email;
  const save = useSaveSettings();
  // Tools links straight here with ?provider=hostinger, so arriving from that
  // card lands on the token field rather than on a form of SMTP boxes.
  const [params] = useSearchParams();
  const [provider, setProvider] = useState<"hostinger" | "smtp">(
    params.get("provider") === "hostinger" || email.transport === "HOSTINGER" ? "hostinger" : "smtp",
  );
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
  // Disconnecting means the live transport, not both — dropping the Hostinger
  // token should not also wipe an SMTP mailbox that is sitting there configured.
  const remove = useMutation({
    mutationFn: () => api.delete<AppSettings>(email.transport === "HOSTINGER" ? "/settings/email/hostinger" : "/settings/email"),
    onSuccess: save,
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; to: string }>("/settings/email/test", { to: testTo.trim() }),
    onSuccess: (result) => setTestResult(`Sent to ${result.to}. If it doesn't arrive, check the spam folder before anything else.`),
    onError: (err: Error) => setTestResult(err.message),
  });

  /** The mailboxes Dakyworld realistically sends from. Hostinger is not an SMTP preset — it has its own form. */
  const presets = [
    { label: "Google Workspace", host: "smtp.gmail.com", port: 587, note: "Use an App Password, not the account password." },
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
        !email.configured &&
        (provider === "hostinger" ? (
          <>
            The token is made in hPanel, under{" "}
            <a className="text-blue hover:underline" href="https://hpanel.hostinger.com/emails" target="_blank" rel="noreferrer">
              Emails
            </a>{" "}
            → your domain → Agentic mail → API → Create API token. Scope it to the mailbox you send from. It is shown once, so
            copy it as it appears.
          </>
        ) : (
          <>
            Any mailbox with SMTP works. On Google Workspace you need an{" "}
            <a
              className="text-blue hover:underline"
              href="https://myaccount.google.com/apppasswords"
              target="_blank"
              rel="noreferrer"
            >
              App Password
            </a>{" "}
            rather than the account password — Google refuses plain logins from applications.
          </>
        ))
      }
      state={
        email.configured ? (
          <Connected>
            <span>
              {email.fromName} &lt;{email.fromEmail}&gt;
            </span>
            <span className="font-mono text-xs text-ink/50">
              {email.transport === "HOSTINGER"
                ? email.hostinger.mcp?.ok
                  ? `hostinger mcp · ${email.hostinger.mcp.tool}`
                  : "hostinger mail api"
                : `${email.host}:${email.port}`}
            </span>
            {!(email.transport === "HOSTINGER" ? email.hostinger.envManaged : email.envManaged) && (
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
      <div className="mt-4 flex flex-wrap gap-2">
        <Chip
          selected={provider === "hostinger"}
          title="One API token. Sends through Hostinger's MCP server."
          onClick={() => setProvider("hostinger")}
        >
          Hostinger · MCP
        </Chip>
        {presets.map((preset) => (
          <Chip
            key={preset.label}
            selected={provider === "smtp" && host === preset.host}
            title={preset.note}
            onClick={() => {
              setProvider("smtp");
              setHost(preset.host);
              setPort(preset.port);
            }}
          >
            {preset.label}
          </Chip>
        ))}
        <Chip
          selected={provider === "smtp" && !presets.some((preset) => preset.host === host)}
          title="Any other mailbox, by SMTP."
          onClick={() => setProvider("smtp")}
        >
          Other · SMTP
        </Chip>
      </div>

      {provider === "hostinger" ? (
        <HostingerForm settings={settings} />
      ) : email.envManaged ? (
        <EnvNote variable="SMTP_HOST" />
      ) : (
        <>
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


/**
 * Reading the same mailbox.
 *
 * A second panel rather than four more fields on the one above, because the two
 * genuinely fail apart: a provider with IMAP switched off, or an App Password
 * scoped to sending, sends perfectly and reads nothing. One "email is
 * connected" covering both is what would hide exactly that.
 *
 * **It arrives filled in.** The host is the SMTP host with `smtp` swapped for
 * `imap`, the port is 993, the username is the same, and the password is
 * usually the same App Password already stored — so the normal path through
 * this form is to read it and press Connect.
 */
function InboxPanel({ settings }: { settings: AppSettings }) {
  const inbox = settings.email.inbox;
  const save = useSaveSettings();
  const qc = useQueryClient();

  const { data: suggestion } = useQuery({
    queryKey: ["inbox-suggestion"],
    queryFn: () => api.get<InboxSuggestion>("/settings/inbox/suggestion"),
    enabled: !inbox.configured,
  });

  const [host, setHost] = useState(inbox.host ?? "");
  const [port, setPort] = useState(String(inbox.port ?? 993));
  const [user, setUser] = useState(inbox.user ?? "");
  const [password, setPassword] = useState("");
  const [triage, setTriage] = useState(inbox.triage);
  const [autoRoute, setAutoRoute] = useState(inbox.autoRoute);
  const [backfillDays, setBackfillDays] = useState(String(inbox.backfillDays ?? 14));

  // Only ever fills blanks. A value typed into this form is a decision and has
  // to survive the suggestion arriving a moment after the screen opened.
  useEffect(() => {
    if (!suggestion) return;
    setHost((current) => current || suggestion.host);
    setUser((current) => current || suggestion.user);
  }, [suggestion]);

  const connect = useMutation({
    mutationFn: () =>
      api.put<AppSettings>("/settings/inbox", {
        host: host.trim(),
        port: Number(port) || 993,
        secure: (Number(port) || 993) === 993,
        user: user.trim(),
        password: password || undefined,
        triage,
        autoRoute,
        backfillDays: Number(backfillDays) || 14,
      }),
    onSuccess: (result) => {
      save(result);
      setPassword("");
      void qc.invalidateQueries({ queryKey: ["inbox-status"] });
    },
  });

  const pause = useMutation({
    mutationFn: (enabled: boolean) => api.post<AppSettings>("/settings/inbox/pause", { enabled }),
    onSuccess: save,
  });

  const disconnect = useMutation({
    mutationFn: () => api.delete<AppSettings>("/settings/inbox"),
    onSuccess: (result) => {
      save(result);
      setPassword("");
    },
  });

  const canSubmit = host.trim().length > 2 && user.trim().length > 2 && (password.length > 0 || suggestion?.canReusePassword || inbox.configured);

  return (
    <Panel
      title="Reading the inbox"
      what={
        <>
          Replies, enquiries and bounces — read as they arrive, matched to the lead or client they belong to, and handed to the agent
          whose job it is. Reading the Sent folder too is what stops a sequence chasing somebody you already answered from your phone.
        </>
      }
      where={
        inbox.envManaged
          ? "Pinned by environment variables on this deployment. Change them in Railway."
          : "The same mailbox as above, over IMAP. Google Workspace and most hosts need an App Password, which is usually the one already stored for sending."
      }
      state={
        inbox.configured ? (
          <Connected>
            <span className="text-ink/70">
              {inbox.user} at {inbox.host}
            </span>
            <span className="text-ink/45">
              {inbox.watcher.connected ? "live connection open" : "reading on the minute"}
              {inbox.sentFolder ? ` · Sent: ${inbox.sentFolder}` : " · no Sent folder found"}
            </span>
          </Connected>
        ) : inbox.paused ? (
          <NotConnected>Reading is switched off. The credentials are still stored.</NotConnected>
        ) : (
          <NotConnected>Nothing reads the mailbox, so a reply only exists in your own webmail.</NotConnected>
        )
      }
    >
      {inbox.folders.some((folder) => folder.lastError) && (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {inbox.folders
            .filter((folder) => folder.lastError)
            .map((folder) => (
              <p key={folder.folder}>
                {folder.folder}: {folder.lastError}
              </p>
            ))}
        </div>
      )}

      {!inbox.envManaged && (
        <>
          <form
            className="mt-6 grid gap-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit) connect.mutate();
            }}
          >
            <Field label="IMAP server">
              <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="imap.hostinger.com" className="input" />
            </Field>
            <Field label="Port" hint="993 with TLS. 143 is the older, worse pair.">
              <input value={port} onChange={(event) => setPort(event.target.value)} className="input" />
            </Field>
            <Field label="Username">
              <input value={user} onChange={(event) => setUser(event.target.value)} placeholder="dan@dakyworld.com" className="input" />
            </Field>
            <Field
              label="Password"
              hint={
                inbox.configured
                  ? "Stored encrypted. Leave blank to keep it."
                  : suggestion?.canReusePassword
                    ? "Leave blank to reuse the one already stored for sending."
                    : "An App Password where the mailbox has two-factor authentication on."
              }
            >
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
                className="input"
              />
            </Field>
            <Field label="Read the last" hint="How far back the very first pass reaches, in days.">
              <input value={backfillDays} onChange={(event) => setBackfillDays(event.target.value)} className="input" />
            </Field>
            <div className="sm:col-span-2 space-y-3">
              <Toggle
                checked={triage}
                onChange={setTriage}
                label="Read each message with a model, to say what it is"
              />
              <Toggle
                checked={autoRoute}
                onChange={setAutoRoute}
                label="Hand messages to the agent whose job it is"
              />
              <p className="text-xs text-ink/45">
                With both off, mail is still filed, sequences still stop when somebody replies and bounces are still suppressed — those
                are code, not judgement. Nothing here ever sends: a reply an agent writes is a draft you send.
              </p>
            </div>
            <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={connect.isPending || !canSubmit}>
                {connect.isPending ? "Checking with the server…" : inbox.configured ? "Save" : "Connect"}
              </Button>
              <span className="text-xs text-ink/45">Checked against the mail server before it's saved.</span>
              {inbox.configured && (
                <Button variant="ghost" onClick={() => pause.mutate(inbox.paused)} disabled={pause.isPending}>
                  {inbox.paused ? "Start reading again" : "Pause reading"}
                </Button>
              )}
              {inbox.configured && (
                <Button variant="ghost" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
                  Disconnect
                </Button>
              )}
            </div>
          </form>
          <ErrorNote error={connect.error} />
        </>
      )}
    </Panel>
  );
}

/**
 * Hostinger, in one field.
 *
 * The token is the whole configuration. The mailbox it may send from comes back
 * from Hostinger and is stored, so nothing else is asked for — and when the
 * token reaches more than one mailbox, the choice appears only then, already
 * answered with the first.
 */
function HostingerForm({ settings }: { settings: AppSettings }) {
  const email = settings.email;
  const hostinger = email.hostinger;
  const save = useSaveSettings();
  const [token, setToken] = useState("");
  const [fromName, setFromName] = useState(email.fromName ?? "Dan Kwame Ayipah");
  const [sign, setSign] = useState(email.signature ?? "");

  const connect = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put<AppSettings>("/settings/email/hostinger", body),
    onSuccess: (result) => {
      save(result);
      setToken("");
    },
  });

  if (hostinger.envManaged) return <EnvNote variable="HOSTINGER_MAIL_TOKEN" />;

  const live = email.transport === "HOSTINGER" && hostinger.configured;

  return (
    <>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (token.trim() || live) connect.mutate({ ...(token.trim() ? { token: token.trim() } : {}), fromName, signature: sign });
        }}
      >
        <Field
          label="API token"
          hint={live ? "Stored encrypted. Paste a new one to rotate it." : "hPanel → Emails → Agentic mail → API. Shown once."}
          full
        >
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={live ? `${hostinger.token} (unchanged)` : "Paste the token — that's all this needs"}
            className="input"
          />
        </Field>

        {/* Only worth a question when there is actually a choice to make. */}
        {hostinger.mailboxes.length > 1 && (
          <Field label="Send from" hint="Every mailbox this token can reach." full>
            <select
              className="input"
              value={hostinger.mailboxId ?? ""}
              onChange={(event) => connect.mutate({ mailboxId: event.target.value })}
            >
              {hostinger.mailboxes.map((mailbox) => (
                <option key={mailbox.resourceId} value={mailbox.resourceId}>
                  {mailbox.address}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="From name" full={!hostinger.mailboxAddress}>
          <input value={fromName} onChange={(event) => setFromName(event.target.value)} className="input" />
        </Field>
        {/* Nothing to show until a token has said what the address is. */}
        {hostinger.mailboxAddress && (
          <Field label="From address" hint="Read back from Hostinger — the token decides this.">
            <input value={hostinger.mailboxAddress} readOnly disabled className="input" />
          </Field>
        )}
        <Field label="Signature" hint="Appended to every email the app sends." full>
          <textarea rows={3} value={sign} onChange={(event) => setSign(event.target.value)} className="input" />
        </Field>

        <div className="sm:col-span-2 flex items-center gap-3">
          <Button type="submit" disabled={connect.isPending || (!token.trim() && !live)}>
            {connect.isPending ? "Checking with Hostinger…" : live ? "Save" : "Connect"}
          </Button>
          <span className="text-xs text-ink/45">Checked against Hostinger before it's saved.</span>
        </div>
      </form>

      <ErrorNote error={connect.error} />
      {hostinger.error && <p className="mt-3 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{hostinger.error}</p>}

      {/* Which path a send will actually take. Worth stating plainly: the MCP
          server and the plain Mail API fail in different ways. */}
      {hostinger.mcp && (
        <p
          className={`mt-3 px-3 py-2 text-sm ${
            hostinger.mcp.ok ? "border border-line bg-ink/[.02] text-ink/60" : "border border-amber-200 bg-amber-50 text-amber-800"
          }`}
        >
          {hostinger.mcp.ok ? (
            <>
              MCP connected — sending through <code className="font-mono text-xs">{hostinger.mcp.tool}</code>, one of{" "}
              {hostinger.mcp.tools.length} tools the mailbox offers.
            </>
          ) : (
            <>
              The MCP server didn't answer ({hostinger.mcp.error}). Mail still sends, through Hostinger's Mail API with the same
              token.
            </>
          )}
        </p>
      )}

      {live && (
        <p className="mt-3 text-xs text-ink/45">
          Two things SMTP does that this path can't: a reply-to address different from the mailbox, and the one-click unsubscribe
          header. The unsubscribe link inside every cold email is unaffected.
        </p>
      )}
    </>
  );
}

// --- Shared shell ----------------------------------------------------------

/** A one-click choice that stays visibly chosen. */
function Chip({
  children,
  selected,
  title,
  onClick,
}: {
  children: ReactNode;
  selected: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[.1em] transition ${
        selected ? "border-ink bg-ink text-cream" : "border-ink/15 text-ink/55 hover:border-ink hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

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
    <section className="rounded-2xl border border-line bg-white p-6">
      <h2 className="font-display text-2xl">{title}</h2>
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
      <Badge tone="positive">connected</Badge>
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
            <a className="text-blue hover:underline" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
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

// --- AI models -------------------------------------------------------------

/**
 * Four vendors, five jobs.
 *
 * The screen is built around the *job* rather than the vendor, because that is
 * the decision: "who writes our proposals" is a question with consequences,
 * and "is the OpenAI key set" is a detail. So the routing table comes first and
 * the keys come second.
 *
 * **Nothing here has to be filled in for the system to work.** Every job falls
 * back to Claude, which is already connected, and each key the Owner pastes
 * moves one job onto the model chosen for it. The panel says which jobs are
 * falling back rather than pretending they are configured.
 */
function ModelsPanel({ settings }: { settings: AppSettings }) {
  const { providers, routing, jobs } = settings.models;
  const byKey = new Map(providers.map((provider) => [provider.key, provider]));
  const jobInfo = new Map(jobs.map((job) => [job.job, job]));
  const fallingBack = routing.filter((route) => !route.ready);

  return (
    <div className="space-y-6">
      <Panel
        title="Who does what"
        what={
          <>
            Each job goes to the model picked for it. Gemini writes, ChatGPT draws and builds pages, Perplexity checks facts against
            live sources and rewrites drafts into plain English. Anything whose model isn't connected yet falls back to Claude, so
            nothing waits on a key.
          </>
        }
        state={
          fallingBack.length === 0 ? (
            <Connected>Every job is going to the model chosen for it.</Connected>
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-sm text-ink/60">
              <Badge tone="muted">
                {fallingBack.length} of {routing.length} falling back
              </Badge>
              <span>Claude is covering {fallingBack.map((route) => jobInfo.get(route.job)?.phrase).join(", ")}.</span>
            </div>
          )
        }
      >
        <div className="mt-5 space-y-3">
          {routing.map((route) => (
            <RouteRow key={route.job} route={route} info={jobInfo.get(route.job)} providers={providers} />
          ))}
        </div>
      </Panel>

      {providers
        .filter((provider) => provider.key !== "anthropic")
        .map((provider) => (
          <ProviderPanel key={provider.key} provider={provider} jobInfo={jobInfo} />
        ))}

      <Panel
        title="Claude"
        what={
          <>
            Reads imported spreadsheets, runs the agent workforce, and stands in for any job above whose own model isn't connected.
            Its key lives under <span className="font-mono text-xs">AI analyst</span>.
          </>
        }
        state={
          byKey.get("anthropic")?.configured ? (
            <Connected>
              <span className="text-xs text-ink/40">{byKey.get("anthropic")?.model}</span>
              <span className="text-xs text-ink/45">
                Covering {routing.filter((route) => route.serving === "anthropic").length} of {routing.length} jobs.
              </span>
            </Connected>
          ) : (
            <NotConnected>
              Nothing can fall back until this one is connected — add the key under AI analyst.
            </NotConnected>
          )
        }
      />
    </div>
  );
}

/** One job, and the dropdown that decides who does it. */
function RouteRow({
  route,
  info,
  providers,
}: {
  route: ModelRoute;
  info?: ModelJobInfo;
  providers: ModelProvider[];
}) {
  const save = useSaveSettings();
  const eligible = providers.filter((provider) => provider.jobs.includes(route.job));

  const choose = useMutation({
    mutationFn: (provider: string) => api.put<AppSettings>(`/settings/models/routes/${route.job}`, { provider }),
    onSuccess: save,
  });

  return (
    <div className="rounded-xl border border-line px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusDot tone={route.ready ? "ok" : "warn"} />
            <span className="font-mono text-[11px] uppercase tracking-[.12em]">{info?.name ?? route.job}</span>
          </div>
          <p className="mt-1 text-sm text-ink/55">{info?.blurb}</p>
        </div>

        <div className="shrink-0">
          <label className="block font-mono text-[10px] uppercase tracking-[.12em] text-ink/45">Handled by</label>
          <select
            value={route.chosen}
            onChange={(event) => choose.mutate(event.target.value)}
            disabled={choose.isPending}
            className="input mt-1 w-48"
          >
            {eligible.map((provider) => (
              <option key={provider.key} value={provider.key}>
                {provider.name}
                {provider.configured ? "" : " (no key yet)"}
              </option>
            ))}
          </select>
        </div>
      </div>

      {route.note && <p className="mt-3 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{route.note}</p>}
      {route.ready && <p className="mt-2 font-mono text-[11px] text-ink/40">{route.model}</p>}
      <ErrorNote error={choose.error} />
    </div>
  );
}

/** One vendor: the key, the model, and what it is currently doing. */
function ProviderPanel({
  provider,
  jobInfo,
}: {
  provider: ModelProvider;
  jobInfo: Map<ModelJob, ModelJobInfo>;
}) {
  const save = useSaveSettings();
  const [key, setKey] = useState("");
  const [model, setModel] = useState(provider.model);

  // Reload when the snapshot changes underneath — saving a key returns a fresh
  // one, and the model field must not revert to a stale copy.
  const [loadedFor, setLoadedFor] = useState(provider.model);
  useEffect(() => {
    if (loadedFor === provider.model) return;
    setLoadedFor(provider.model);
    setModel(provider.model);
  }, [provider.model, loadedFor]);

  const connect = useMutation({
    mutationFn: () => api.put<AppSettings>(`/settings/models/${provider.key}`, { key: key.trim() }),
    onSuccess: (result) => {
      setKey("");
      save(result);
    },
  });
  const setModelFor = useMutation({
    mutationFn: () => api.put<AppSettings>(`/settings/models/${provider.key}`, { model: model.trim() || null }),
    onSuccess: save,
  });
  const setImageModel = useMutation({
    mutationFn: (next: string) => api.put<AppSettings>(`/settings/models/${provider.key}`, { imageModel: next.trim() || null }),
    onSuccess: save,
  });
  const remove = useMutation({
    mutationFn: () => api.delete<AppSettings>(`/settings/models/${provider.key}`),
    onSuccess: save,
  });

  const doing = provider.serving.map((job) => jobInfo.get(job)?.phrase ?? job);

  return (
    <Panel
      title={provider.name}
      what={<>{provider.purpose}</>}
      where={
        !provider.configured && (
          <>
            Create a key at{" "}
            <a className="text-blue hover:underline" href={provider.console} target="_blank" rel="noreferrer">
              {new URL(provider.console).host}
            </a>
            . It is checked against {provider.vendor} before it is saved, so a typo is caught here rather than on the first draft.
          </>
        )
      }
      state={
        provider.configured ? (
          <Connected>
            <span className="font-mono text-xs text-ink/50">{provider.keyPreview}</span>
            <span className="text-xs text-ink/40">{provider.model}</span>
            <span className="text-xs text-ink/45">{doing.length > 0 ? `Doing: ${doing.join(", ")}.` : "Nothing routed to it."}</span>
            {!provider.envManaged && (
              <Button variant="ghost" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Remove key
              </Button>
            )}
          </Connected>
        ) : (
          <NotConnected>
            {provider.jobs.length > 0
              ? `${provider.jobs.map((job) => jobInfo.get(job)?.phrase ?? job).join(", ")} would come here.`
              : "Nothing is routed here yet."}
          </NotConnected>
        )
      }
    >
      {provider.envManaged ? (
        <EnvNote variable={`${provider.key.toUpperCase()}_API_KEY`} />
      ) : (
        !provider.configured && (
          <form
            className="mt-4 flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (key.trim()) connect.mutate();
            }}
          >
            <div className="min-w-[22rem] flex-1">
              <Field label={`${provider.vendor} API key`}>
                <input
                  type="password"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder={provider.keyHint}
                  autoComplete="off"
                  className="input font-mono text-xs"
                />
              </Field>
            </div>
            <Button type="submit" disabled={connect.isPending || key.trim().length < 8}>
              {connect.isPending ? "Checking…" : "Save key"}
            </Button>
          </form>
        )
      )}

      {provider.configured && (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setModelFor.mutate();
          }}
        >
          <div className="min-w-[18rem] flex-1">
            <Field label="Model" hint={`Blank uses ${provider.defaultModel}.`}>
              <input
                list={`${provider.key}-models`}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={provider.defaultModel}
                className="input font-mono text-xs"
              />
              <datalist id={`${provider.key}-models`}>
                {provider.models.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            </Field>
          </div>
          <Button type="submit" variant="secondary" disabled={setModelFor.isPending || model === provider.model}>
            {setModelFor.isPending ? "Saving…" : "Use this model"}
          </Button>
        </form>
      )}

      {/* ChatGPT draws with a different model from the one it writes with, so the
          box that matters most for it is this one rather than the one above. */}
      {provider.configured && provider.jobs.includes("image") && (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const value = new FormData(event.currentTarget).get("imageModel");
            setImageModel.mutate(String(value ?? ""));
          }}
        >
          <div className="min-w-[18rem] flex-1">
            <Field label="Image model" hint="Blank uses gpt-image-1.5.">
              <input
                name="imageModel"
                list={`${provider.key}-image-models`}
                defaultValue=""
                placeholder="gpt-image-1.5"
                className="input font-mono text-xs"
              />
              <datalist id={`${provider.key}-image-models`}>
                <option value="gpt-image-1.5" />
                <option value="gpt-image-2" />
                <option value="gpt-image-1-mini" />
              </datalist>
            </Field>
          </div>
          <Button type="submit" variant="secondary" disabled={setImageModel.isPending}>
            {setImageModel.isPending ? "Saving…" : "Use this one"}
          </Button>
        </form>
      )}

      <ErrorNote error={connect.error ?? setModelFor.error ?? setImageModel.error ?? remove.error} />
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
            <code className="flex-1 break-all rounded-lg border border-line bg-cream px-2 py-1.5 text-xs">{google.redirectUri}</code>
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

          <details className="mt-5 rounded-2xl border border-line bg-cream">
            <summary className="cursor-pointer px-4 py-3 font-mono text-[10px] uppercase tracking-[.14em] text-ink/50">
              How to create the OAuth client
            </summary>
            <ol className="list-decimal space-y-2 px-8 py-4 text-sm text-ink/65">
              <li>
                In{" "}
                <a className="text-blue hover:underline" href="https://console.cloud.google.com" target="_blank" rel="noreferrer">
                  console.cloud.google.com
                </a>
                , create a project.
              </li>
              <li>
                <strong>APIs &amp; Services → Library</strong>: enable the <strong>Google Drive API</strong>, the{" "}
                <strong>Google Sheets API</strong> and the <strong>Google Calendar API</strong>. All three.
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
      <CalendarSection settings={settings} onReconnect={() => connect.mutate()} />
      <ErrorNote error={saveClient.error ?? connect.error ?? disconnect.error ?? removeClient.error} />
    </Panel>
  );
}

/**
 * Which calendar the agents book into.
 *
 * Calendar rides on the same Google connection as Drive rather than asking for
 * a second one, and the price of that is visible here: an account connected
 * before calendar access was added holds a token that calendar calls are
 * refused on. Saying so with a reconnect button beats discovering it at the
 * moment somebody tries to book a consultation.
 */
function CalendarSection({ settings, onReconnect }: { settings: AppSettings; onReconnect: () => void }) {
  const save = useSaveSettings();
  const calendar = settings.calendar;
  const [chosen, setChosen] = useState(calendar.calendarId);

  const choose = useMutation({
    mutationFn: (calendarId: string) => api.put<AppSettings>("/settings/calendar", { calendarId }),
    onSuccess: save,
  });

  if (!settings.google.connected) return null;

  return (
    <div className="mt-6 border-t border-ink/10 pt-5">
      <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">Calendar</h3>

      {!calendar.scoped ? (
        <div className="mt-2 border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-sm text-amber-900">
            This account was connected before calendar access existed, so booking is off. Reconnecting grants it — nothing else
            changes.
          </p>
          <Button className="mt-2" size="sm" onClick={onReconnect}>
            Reconnect Google
          </Button>
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-ink/55">
            Where an agent books a consultation. A shared calendar the team can see beats the account's own once more than one
            person needs to know what was booked.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="Book into">
              <select
                value={chosen}
                onChange={(event) => setChosen(event.target.value)}
                className="input"
              >
                <option value="primary">The connected account's own calendar</option>
                {calendar.calendars
                  .filter((entry) => !entry.primary)
                  .map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
              </select>
            </Field>
            {chosen !== calendar.calendarId && (
              <Button size="sm" onClick={() => choose.mutate(chosen)} disabled={choose.isPending}>
                {choose.isPending ? "Saving…" : "Save"}
              </Button>
            )}
          </div>
          <ErrorNote error={choose.error} />
        </>
      )}
    </div>
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
              className="text-blue hover:underline"
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

      <CaptureTasks settings={settings} />
      <CaptureBehaviour settings={settings} />
      <ActorHealthList />
    </Panel>
  );
}

/**
 * Which pre-defined actor runs which kind of capture.
 *
 * Quick capture works out what you typed — a site, a search phrase, a
 * Facebook Page — and runs the actor paired with it here. The pairing shipped
 * with the app and is worth changing exactly twice: when a better actor turns
 * up, and when the one in use starts failing. Nothing else needs an actor id.
 */
function CaptureTasks({ settings }: { settings: AppSettings }) {
  const save = useSaveSettings();
  const tasks = settings.capture.tasks ?? [];
  const [editing, setEditing] = useState<string | null>(null);
  const [actorId, setActorId] = useState("");

  const point = useMutation({
    mutationFn: (task: { kind: string; actorId: string }) =>
      api.put<AppSettings>(`/settings/capture/actors/${task.kind}`, { actorId: task.actorId }),
    onSuccess: (result) => {
      save(result);
      setEditing(null);
    },
  });
  const reset = useMutation({
    mutationFn: (kind: string) => api.delete<AppSettings>(`/settings/capture/actors/${kind}`),
    onSuccess: save,
  });

  if (!tasks.length) return null;

  return (
    <div className="mt-8 border-t border-ink/10 pt-5">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">What runs what</div>
      <p className="mb-4 max-w-2xl text-sm text-ink/55">
        Type a link or a phrase into Quick capture and it works out which of these it is, then runs the actor paired with it. The
        pairings below are the ones the app ships with — change one only to move a task onto a different actor.
      </p>

      <div className="divide-y divide-ink/5 border border-line">
        {tasks.map((task) => (
          <div key={task.kind} className="grid gap-3 px-4 py-3 sm:grid-cols-[13rem_1fr]">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink">{task.label}</span>
                {task.overridden && <Badge>changed</Badge>}
              </div>
              <p className="mt-0.5 text-xs text-ink/45">{task.takes}</p>
              <p className="mt-1 font-mono text-[10px] text-ink/35">e.g. {task.example}</p>
            </div>

            {editing === task.kind ? (
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  point.mutate({ kind: task.kind, actorId: actorId.trim() });
                }}
              >
                <input
                  className="input max-w-sm flex-1 font-mono text-xs"
                  value={actorId}
                  onChange={(event) => setActorId(event.target.value)}
                  placeholder={task.defaultActorId}
                  autoFocus
                />
                <Button type="submit" size="sm" disabled={point.isPending || !actorId.trim()}>
                  {point.isPending ? "Saving…" : "Save"}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <code className="font-mono text-xs text-ink/70">{task.actorId}</code>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(task.kind);
                    setActorId(task.actorId);
                  }}
                  className="font-mono text-[10px] uppercase tracking-[.12em] text-blue hover:underline"
                >
                  Change
                </button>
                {task.overridden && (
                  <button
                    type="button"
                    onClick={() => reset.mutate(task.kind)}
                    disabled={reset.isPending}
                    className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40 hover:text-ink hover:underline"
                  >
                    Put back
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <ErrorNote error={point.error ?? reset.error} />
    </div>
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
    <section className="rounded-2xl border border-line bg-cream/40 p-4">
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
            <div key={actor.actorId} className="rounded-xl border border-line bg-white px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <StatusDot tone={!actor.reachable ? "bad" : problems.length ? "warn" : "ok"} />
                <a
                  href={`https://apify.com/${actor.actorId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs hover:text-blue hover:underline"
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
            <a className="text-blue hover:underline" href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noreferrer">
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
            <Badge tone={stripe.livemode ? "positive" : "muted"}>{stripe.livemode ? "live mode" : "test mode"}</Badge>
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
            <code className="flex-1 break-all rounded-lg border border-line bg-cream px-2 py-1.5 text-xs">{stripe.webhookUrl}</code>
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
            <a className="text-blue hover:underline" href="https://console.cloudinary.com" target="_blank" rel="noreferrer">
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


// --- Alerts (Slack) --------------------------------------------------------

/**
 * Slack, two ways in, and the cheap one is usually right.
 *
 * A webhook URL is one paste and no app review; it posts to the single channel
 * it was created for, which is all "tell me when a capture fails" needs. A bot
 * token is only worth the setup once escalations should land somewhere
 * different from run reports — that is the one thing a webhook cannot do.
 */
function AlertsPanel({ settings }: { settings: AppSettings }) {
  const save = useSaveSettings();
  const [webhookUrl, setWebhookUrl] = useState("");
  const [botToken, setBotToken] = useState("");
  const [channel, setChannel] = useState(settings.alerts.defaultChannel ?? "");
  const [signingSecret, setSigningSecret] = useState("");
  // Defaulted rather than assumed: a whole Settings screen going blank because
  // one field arrived undefined is a bad trade for one character saved.
  const [approvers, setApprovers] = useState((settings.alerts.approvers ?? []).join(", "));

  const connect = useMutation({
    mutationFn: () =>
      api.put<AppSettings>("/settings/slack", {
        webhookUrl,
        botToken,
        defaultChannel: channel,
        ...(signingSecret.trim() ? { signingSecret } : {}),
        approvers: approvers.split(/[,\s]+/).filter(Boolean),
      }),
    onSuccess: (result) => {
      setWebhookUrl("");
      setBotToken("");
      setSigningSecret("");
      save(result);
    },
  });
  const remove = useMutation({ mutationFn: () => api.delete<AppSettings>("/settings/slack"), onSuccess: save });
  const test = useMutation({ mutationFn: () => api.post<{ delivered: boolean; channel: string | null }>("/settings/slack/test", {}) });

  const alerts = settings.alerts;

  return (
    <Panel
      title="Alerts"
      what={
        <>
          Where the system interrupts you: a scheduled capture that failed at 06:00, a lead worth stopping for, an agent that
          escalated. Without it those arrive by email, which works — this is for the ones you want to see immediately.
        </>
      }
      where={
        !alerts.configured && (
          <>
            The quickest route is an{" "}
            <a className="text-blue hover:underline" href="https://api.slack.com/messaging/webhooks" target="_blank" rel="noreferrer">
              incoming webhook
            </a>{" "}
            — create one against a channel and paste the URL. A bot token (<code className="font-mono">xoxb-…</code> with{" "}
            <code className="font-mono">chat:write</code>) is only needed if agents should choose the channel per message.
          </>
        )
      }
      state={
        alerts.configured ? (
          <Connected>
            <span>{alerts.transport === "TOKEN" ? "Bot token" : "Incoming webhook"}</span>
            <span className="font-mono text-xs text-ink/50">{alerts.botToken ?? alerts.webhookUrl}</span>
            {alerts.defaultChannel && <span className="text-ink/50">→ {alerts.defaultChannel}</span>}
            <Button variant="ghost" size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
              {test.isPending ? "Sending…" : "Send a test"}
            </Button>
            {!alerts.envManaged && (
              <Button variant="ghost" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Remove
              </Button>
            )}
          </Connected>
        ) : (
          <NotConnected>Alerts arrive by email only.</NotConnected>
        )
      }
    >
      {test.isSuccess && (
        <p className="mt-3 border border-line bg-ink/[.02] px-3 py-2 text-sm text-ink/60">
          Sent. If nothing arrived, the bot probably isn't in that channel yet.
        </p>
      )}

      {alerts.envManaged ? (
        <EnvNote variable="SLACK_WEBHOOK_URL" />
      ) : (
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            connect.mutate();
          }}
        >
          <Field label="Incoming webhook URL">
            <input
              value={webhookUrl}
              onChange={(event) => setWebhookUrl(event.target.value)}
              placeholder="https://hooks.slack.com/services/…"
              autoComplete="off"
              className="input font-mono text-xs"
            />
          </Field>
          <Field label="Bot token (optional)">
            <input
              type="password"
              value={botToken}
              onChange={(event) => setBotToken(event.target.value)}
              placeholder="xoxb-…"
              autoComplete="off"
              className="input font-mono text-xs"
            />
          </Field>
          <Field label="Default channel">
            <input
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
              placeholder="#alerts"
              className="input"
            />
          </Field>

          {/* The inbound half. Separated by a rule because everything above is
              "can we post to Slack" and everything below is "can Slack decide
              something here", which is a much bigger permission. */}
          <div className="sm:col-span-2 border-t border-line pt-4">
            <p className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">Letting Slack answer back</p>
            <p className="mt-1 text-sm text-ink/55">
              Needed for the Approve and Decline buttons on a hiring card, and for <code className="font-mono">/dakyworld</code>. Create a
              Slack app, switch on Interactivity with the request URL{" "}
              <code className="font-mono text-xs">{`${window.location.origin}/api/slack/actions`}</code>, add a slash command pointing at{" "}
              <code className="font-mono text-xs">{`${window.location.origin}/api/slack/commands`}</code>, and paste the signing secret from
              Basic Information. Without it every inbound Slack request is refused.
            </p>
          </div>
          <Field label="Signing secret" hint={alerts.canReceive ? `Set — ${alerts.signingSecret}` : "Not set, so the buttons do nothing"}>
            <input
              type="password"
              value={signingSecret}
              onChange={(event) => setSigningSecret(event.target.value)}
              placeholder={alerts.canReceive ? "•••• (leave blank to keep)" : "a long hex string"}
              autoComplete="off"
              className="input font-mono text-xs"
            />
          </Field>
          <Field label="Who may approve" hint="Slack user ids, comma separated. Blank means anyone in the channel.">
            <input
              value={approvers}
              onChange={(event) => setApprovers(event.target.value)}
              placeholder="U01ABCDEF"
              className="input font-mono text-xs"
            />
          </Field>

          <div className="sm:col-span-2">
            <Button type="submit" disabled={connect.isPending}>
              {connect.isPending ? "Checking…" : "Save"}
            </Button>
          </div>
        </form>
      )}
      <ErrorNote error={connect.error ?? remove.error ?? test.error} />
    </Panel>
  );
}

// --- Developer (GitHub) ----------------------------------------------------

function DeveloperPanel({ settings }: { settings: AppSettings }) {
  const save = useSaveSettings();
  const [token, setToken] = useState("");
  const [owner, setOwner] = useState(settings.developer.owner ?? "");

  const connect = useMutation({
    mutationFn: () => api.put<AppSettings>("/settings/github", { token, owner }),
    onSuccess: (result) => {
      setToken("");
      save(result);
    },
  });
  const remove = useMutation({ mutationFn: () => api.delete<AppSettings>("/settings/github"), onSuccess: save });

  const developer = settings.developer;

  return (
    <Panel
      title="Developer"
      what={
        <>
          What the technical agents read to answer "what shipped this week" and "what is open against this client" — repositories,
          recent commits and issues. They can raise an issue; they cannot touch code.
        </>
      }
      where={
        !developer.configured && (
          <>
            A{" "}
            <a
              className="text-blue hover:underline"
              href="https://github.com/settings/personal-access-tokens"
              target="_blank"
              rel="noreferrer"
            >
              fine-grained token
            </a>{" "}
            with <strong>Contents: read</strong>, <strong>Issues: read and write</strong> and <strong>Metadata: read</strong> on the
            repositories that matter. A classic token with <code className="font-mono">repo</code> also works and is broader than
            needed.
          </>
        )
      }
      state={
        developer.configured ? (
          <Connected>
            <span className="font-mono text-xs text-ink/50">{developer.token}</span>
            {developer.owner && <span className="text-ink/50">default owner: {developer.owner}</span>}
            {!developer.envManaged && (
              <Button variant="ghost" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Remove
              </Button>
            )}
          </Connected>
        ) : (
          <NotConnected>The technical agents have no repository context.</NotConnected>
        )
      }
    >
      {developer.envManaged ? (
        <EnvNote variable="GITHUB_TOKEN" />
      ) : (
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (token.trim() || owner !== (developer.owner ?? "")) connect.mutate();
          }}
        >
          <Field label="Personal access token">
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="github_pat_…"
              autoComplete="off"
              className="input font-mono text-xs"
            />
          </Field>
          <Field label="Default owner">
            <input
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              placeholder="dakyworld"
              className="input"
            />
          </Field>
          <p className="text-xs text-ink/45 sm:col-span-2">
            With a default owner set, a repository can be named <code className="font-mono">os</code> rather than{" "}
            <code className="font-mono">dakyworld/os</code>.
          </p>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={connect.isPending}>
              {connect.isPending ? "Checking…" : "Save"}
            </Button>
          </div>
        </form>
      )}
      <ErrorNote error={connect.error ?? remove.error} />
    </Panel>
  );
}

// --- Webhooks --------------------------------------------------------------

/**
 * The URL to give the website's contact form, and the secret anything else
 * signs with.
 *
 * The form is deliberately allowed to post unsigned: dakyworld.com is a static
 * site on GitHub Pages with nowhere to keep a secret, and losing a real enquiry
 * to a configuration mismatch is worse than accepting an unsigned post that can
 * only ever create a lead. Everything else must sign, and an unsigned event
 * from anywhere else is recorded and ignored rather than acted on.
 */
function WebhooksPanel({ settings }: { settings: AppSettings }) {
  const save = useSaveSettings();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const rotate = useMutation({
    mutationFn: () => api.post<{ secret: string; snapshot: AppSettings }>("/settings/webhooks/rotate", {}),
    onSuccess: (result) => {
      setRevealed(result.secret);
      setConfirming(false);
      save(result.snapshot);
    },
  });

  const webhooks = settings.webhooks;

  return (
    <Panel
      title="Webhooks"
      what={
        <>
          Events in from other systems. The contact form on dakyworld.com posting here creates a scored, de-duplicated lead in the
          pipeline instead of an email somebody retypes on Monday.
        </>
      }
      state={
        <div className="space-y-3 text-sm">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">Contact form posts to</p>
            <code className="mt-1 block break-all font-mono text-xs text-ink/70">{webhooks.formUrl}</code>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">Anything else</p>
            <code className="mt-1 block break-all font-mono text-xs text-ink/70">{webhooks.baseUrl}&lt;source&gt;</code>
          </div>
        </div>
      }
    >
      <div className="mt-4 space-y-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">Signing secret</p>
          <p className="mt-1 text-sm text-ink/55">
            Senders other than the website form must sign: an{" "}
            <code className="font-mono">x-dakyworld-signature</code> header holding the HMAC-SHA256 of{" "}
            <code className="font-mono">{"`${timestamp}.${body}`"}</code>, with the timestamp in{" "}
            <code className="font-mono">x-dakyworld-timestamp</code>. Requests more than five minutes old are refused.
          </p>
          <p className="mt-2 font-mono text-xs text-ink/50">{webhooks.secret}</p>

          {revealed && (
            <p className="mt-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              New secret — copy it now, it is not shown again:
              <code className="mt-1 block break-all font-mono">{revealed}</code>
            </p>
          )}

          {webhooks.envManaged ? (
            <EnvNote variable="WEBHOOK_SECRET" />
          ) : confirming ? (
            <div className="mt-3 border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-sm text-amber-900">
                Every sender already using the old secret will start being rejected until you update it. Only the website form,
                which posts unsigned, keeps working.
              </p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
                  {rotate.isPending ? "Rotating…" : "Rotate anyway"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button className="mt-3" size="sm" variant="secondary" onClick={() => setConfirming(true)}>
              Rotate secret
            </Button>
          )}
        </div>
      </div>
      <ErrorNote error={rotate.error} />
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

/**
 * The account's own security, rather than an integration's.
 *
 * Enrolment is deliberately two steps, and it is the confirm step that turns it
 * on: storing a secret as "enabled" before the app has proved it can read it is
 * how somebody locks themselves out with a mistyped setup key.
 *
 * There is no QR code here on purpose — a QR generator is a dependency and a
 * few hundred lines to save one paste, and every authenticator worth using
 * (Google Authenticator, Authy, 1Password, Bitwarden) accepts a setup key
 * entered by hand.
 */
type TwoFactorState = {
  enabled: boolean;
  pending: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
};

function SecurityPanel() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["2fa"], queryFn: () => api.get<TwoFactorState>("/auth/2fa") });

  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["2fa"] });
  const fail = (err: unknown) => setError(err instanceof ApiError ? err.message : "Something went wrong.");

  const begin = useMutation({
    mutationFn: () => api.post<{ secret: string; uri: string }>("/auth/2fa/setup", {}),
    onSuccess: (result) => {
      setError(null);
      setSetup(result);
    },
    onError: fail,
  });

  const confirm = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>("/auth/2fa/confirm", { code }),
    onSuccess: (result) => {
      setError(null);
      setSetup(null);
      setCode("");
      setRecoveryCodes(result.recoveryCodes);
      refresh();
    },
    onError: fail,
  });

  const disable = useMutation({
    mutationFn: () => api.post("/auth/2fa/disable", { password, code: disableCode }),
    onSuccess: () => {
      setError(null);
      setPassword("");
      setDisableCode("");
      setRecoveryCodes(null);
      refresh();
    },
    onError: fail,
  });

  const regenerate = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>("/auth/2fa/recovery-codes", { password }),
    onSuccess: (result) => {
      setError(null);
      setPassword("");
      setRecoveryCodes(result.recoveryCodes);
      refresh();
    },
    onError: fail,
  });

  // Grouped in fours, because this gets typed into a phone by hand.
  const grouped = setup?.secret.replace(/(.{4})/g, "$1 ").trim();

  return (
    <Panel
      title="Security"
      what={
        <>
          A password is one secret, and a password is the thing that leaks. With two-factor on, whoever has yours still cannot
          reach the leads, the invoices or the mailbox without your phone.
        </>
      }
      state={
        <div className="flex items-center gap-2.5 text-sm">
          <StatusDot tone={data?.enabled ? "ok" : "warn"} />
          {data?.enabled ? (
            <span>
              Two-factor is on. <span className="text-ink/50">{data.recoveryCodesRemaining} recovery codes unused.</span>
            </span>
          ) : (
            <span>Two-factor is off — your password is the only thing between an attacker and this system.</span>
          )}
        </div>
      }
    >
      {error && (
        <p role="alert" className="mt-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {recoveryCodes && (
        <div className="mt-4 border border-amber-200 bg-amber-50 px-3 py-3">
          <p className="text-sm font-bold text-amber-900">Recovery codes — copy them now. They are not shown again.</p>
          <p className="mt-1 text-xs text-amber-900/80">
            Each works once, in place of a code from your phone. Keep them somewhere that is not the phone.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs text-amber-900">
            {recoveryCodes.map((entry) => (
              <span key={entry}>{entry}</span>
            ))}
          </div>
          <div className="mt-3">
            <Button onClick={() => setRecoveryCodes(null)}>I have saved them</Button>
          </div>
        </div>
      )}

      {!data?.enabled && !setup && (
        <div className="mt-4">
          <Button onClick={() => begin.mutate()} disabled={begin.isPending}>
            {begin.isPending ? "Starting…" : "Turn on two-factor"}
          </Button>
        </div>
      )}

      {setup && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            confirm.mutate();
          }}
        >
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">Setup key</p>
            <p className="mt-1 text-sm text-ink/55">
              In your authenticator app, add an account by entering a setup key, and paste this.
            </p>
            <code className="mt-2 block select-all break-all border border-line bg-cream px-3 py-2 font-mono text-sm">
              {grouped}
            </code>
          </div>
          <Field label="Then the six-digit code it shows">
            <input
              className="input font-mono tracking-[.2em]"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              required
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={confirm.isPending || code.trim().length < 6}>
              {confirm.isPending ? "Checking…" : "Confirm"}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setSetup(null);
                setCode("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {data?.enabled && (
        <div className="mt-6 space-y-6 border-t border-ink/10 pt-5">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              regenerate.mutate();
            }}
          >
            <p className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">New recovery codes</p>
            <p className="text-sm text-ink/55">
              Issues a fresh set and voids the old sheet. Worth doing if you cannot account for where the last one ended up.
            </p>
            <Field label="Your password">
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>
            <Button type="submit" disabled={regenerate.isPending || !password}>
              {regenerate.isPending ? "Issuing…" : "Issue new codes"}
            </Button>
          </form>

          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              disable.mutate();
            }}
          >
            <p className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">Turn it off</p>
            <p className="text-sm text-ink/55">
              Both factors are required, so a stolen session cannot strip the protection it has just run into. Fill in the
              password above as well.
            </p>
            <Field label="A current code, or a recovery code">
              <input
                className="input font-mono tracking-[.2em]"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                autoComplete="one-time-code"
                required
              />
            </Field>
            <Button type="submit" disabled={disable.isPending || !password || !disableCode}>
              {disable.isPending ? "Turning off…" : "Turn off two-factor"}
            </Button>
          </form>
        </div>
      )}
    </Panel>
  );
}
