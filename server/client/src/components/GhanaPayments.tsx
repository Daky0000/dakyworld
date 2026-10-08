import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { AppSettings } from "../lib/types";
import { Badge, Button, Field } from "./ui";

/**
 * The two Ghanaian payment rails.
 *
 * Stripe does not acquire in Ghana, and every invoice, proposal and care plan
 * in this system is denominated in GHS — so until these, a real invoice printed
 * with no way to pay it. That was a known open defect rather than an oversight.
 *
 * Two rails rather than one because they answer different questions, and a
 * business here commonly has one and not the other. Paystack is a hosted page
 * for a client comfortable paying on the web; Hubtel is a prompt on the handset
 * for one who is not. The billing agent picks per client and has to say why.
 *
 * **The webhook address is on the panel, not in the documentation.** A key with
 * no webhook takes money perfectly well and never marks the invoice paid, which
 * presents as the integration not working at all. It is the step most likely to
 * be missed, so it is the thing hardest to miss here.
 */

function useSave() {
  const qc = useQueryClient();
  return (result: AppSettings) => qc.setQueryData(["settings"], result);
}

function Shell({ title, what, state, children }: { title: string; what: ReactNode; state: ReactNode; children?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-6">
      <h2 className="font-display text-2xl">{title}</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">{what}</p>
      <div className="mt-4 border-y border-line py-4">{state}</div>
      {children}
    </section>
  );
}

function CopyRow({ label, value, hint }: { label: string; value: string; hint: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4">
      <p className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">{label}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <code className="rounded-[10px] break-all border border-line bg-cream px-2 py-1 font-mono text-xs">{value}</code>
        <button
          type="button"
          className="font-sans text-[11px] uppercase tracking-[.06em] text-blue transition hover:underline"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <p className="mt-1 max-w-2xl text-xs text-muted">{hint}</p>
    </div>
  );
}

function ErrorNote({ error }: { error: unknown }) {
  if (!(error instanceof Error)) return null;
  return <p className="mt-3 rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{error.message}</p>;
}

function EnvNote({ variable }: { variable: string }) {
  return (
    <p className="mt-3 rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-xs text-warn-text">
      Pinned by the <code className="font-mono">{variable}</code> environment variable, so it can't be edited here.
    </p>
  );
}

export function PaystackPanel({ settings }: { settings: AppSettings }) {
  const save = useSave();
  const paystack = settings.paystack;
  const blank = { secret: "", public: "" };
  const [entered, setEntered] = useState<Record<"live" | "test", { secret: string; public: string }>>({ live: blank, test: blank });
  const enter = (mode: "live" | "test", field: "secret" | "public", value: string) =>
    setEntered((current) => ({ ...current, [mode]: { ...current[mode], [field]: value } }));
  const [callbackUrl, setCallbackUrl] = useState(paystack.callbackCustom ? paystack.callbackUrl : "");
  const modes = ["live", "test"] as const;
  const [missing, setMissing] = useState<"live" | "test" | null>(null);

  const connect = useMutation({
    // One save covers both modes: each filled pair is sent on its own, so a
    // rejected live key names live and leaves a good test key stored.
    mutationFn: async () => {
      let result: AppSettings | null = null;
      for (const mode of modes) {
        const secretKey = entered[mode].secret.trim();
        const publicKey = entered[mode].public.trim();
        if (!secretKey && !publicKey) continue;
        if (secretKey && !secretKey.startsWith(`sk_${mode}_`)) throw new Error(`The ${mode} secret key should start with sk_${mode}_.`);
        if (publicKey && !publicKey.startsWith(`pk_${mode}_`)) throw new Error(`The ${mode} public key should start with pk_${mode}_.`);
        try {
          result = await api.put<AppSettings>("/settings/paystack", { ...(secretKey ? { secretKey } : {}), ...(publicKey ? { publicKey } : {}) });
        } catch (err) {
          throw new Error(`${mode === "live" ? "Live" : "Test"}: ${(err as Error).message}`);
        }
        setEntered((current) => ({ ...current, [mode]: blank }));
      }
      if (!paystack.callbackEnvManaged && callbackUrl !== (paystack.callbackCustom ? paystack.callbackUrl : "")) {
        result = await api.put<AppSettings>("/settings/paystack", { callbackUrl });
      }
      return result;
    },
    onSuccess: (result) => {
      if (result) save(result);
    },
  });
  const remove = useMutation({
    mutationFn: (mode: "live" | "test") => api.delete<AppSettings>(`/settings/paystack?mode=${mode}`),
    onSuccess: save,
  });
  const switchMode = useMutation({
    mutationFn: (mode: "live" | "test") => api.put<AppSettings>("/settings/paystack/mode", { mode }),
    onSuccess: save,
  });

  return (
    <Shell
      title="Paystack"
      what={
        <>
          A payment page for an invoice — card, mobile money or bank transfer, on one link you can put in an email. Stripe does not
          acquire in Ghana, so this is what makes a GHS invoice payable at all. Keep a test key and a live key here and switch between
          them.
        </>
      }
      state={
        paystack.configured ? (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="positive">connected</Badge>
              <Badge tone={paystack.livemode ? "warn" : "muted"}>{paystack.livemode ? "live — real money" : "test mode"}</Badge>
              <div className="inline-flex overflow-hidden rounded-full border border-line" role="group" aria-label="Paystack mode">
                {modes.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={paystack.mode === mode}
                    disabled={paystack.modeEnvManaged || switchMode.isPending || paystack.mode === mode}
                    className={`px-3 py-1 font-sans text-[11px] uppercase tracking-[.06em] transition disabled:cursor-not-allowed ${
                      paystack.mode === mode ? "bg-ink text-white" : "text-muted hover:text-ink disabled:opacity-40"
                    }`}
                    onClick={() => {
                      if (!paystack.keys[mode]) {
                        setMissing(mode);
                        return;
                      }
                      setMissing(null);
                      if (mode === "live" && !window.confirm("Switch Paystack to live mode? New payment links will take real money.")) return;
                      switchMode.mutate(mode);
                    }}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
            {modes.map((mode) => (
              <div key={mode} className="flex flex-wrap items-center gap-3">
                <span className="w-10 font-sans text-[11px] uppercase tracking-[.06em] text-muted">{mode}</span>
                {paystack.keys[mode] ? (
                  <>
                    <code className="font-mono text-xs">{paystack.keys[mode]}</code>
                    {paystack.publicKeys[mode] ? (
                      <code className="font-mono text-xs text-muted">{paystack.publicKeys[mode]}</code>
                    ) : (
                      <span className="text-xs text-muted">no public key</span>
                    )}
                    {!paystack.envManaged[mode] && (
                      <button
                        type="button"
                        className="font-sans text-[11px] uppercase tracking-[.06em] text-danger-text/70 transition hover:text-danger-text"
                        onClick={() => remove.mutate(mode)}
                      >
                        remove
                      </button>
                    )}
                  </>
                ) : (
                  <span className="text-xs text-muted">no key</span>
                )}
              </div>
            ))}
            {missing && (
              <p className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-xs text-warn-text">
                There is no {missing} key yet. Fill in the {missing} keys below and save, then switch.
              </p>
            )}
            {paystack.modeEnvManaged && <EnvNote variable="PAYSTACK_MODE" />}
            <ErrorNote error={switchMode.error ?? remove.error} />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <Badge tone="muted">not set up</Badge>
            <span>
              Secret keys from{" "}
              <a className="text-blue hover:underline" href="https://dashboard.paystack.com/#/settings/developers" target="_blank" rel="noreferrer">
                dashboard.paystack.com → Settings → API Keys
              </a>
              . Add a <code className="font-mono text-xs">sk_test_…</code> key and a <code className="font-mono text-xs">sk_live_…</code> key, then
              switch between them here.
            </span>
          </div>
        )
      }
    >
      <div className="mt-4 max-w-xl space-y-3">
        {modes.map((mode) =>
          paystack.envManaged[mode] ? (
            <EnvNote key={mode} variable={mode === "live" ? "PAYSTACK_SECRET_KEY" : "PAYSTACK_TEST_SECRET_KEY"} />
          ) : (
            <fieldset key={mode} className="space-y-3 rounded-xl border border-line p-4">
              <legend className="px-1 font-sans text-[11px] uppercase tracking-[.06em] text-muted">
                {mode} keys {paystack.keys[mode] ? "· saved — paste to replace" : ""}
              </legend>
              <Field label={`${mode === "live" ? "Live" : "Test"} secret key`} full>
                <input className="input" type="password" value={entered[mode].secret} placeholder={`sk_${mode}_…`} onChange={(event) => enter(mode, "secret", event.target.value)} />
              </Field>
              <Field label={`${mode === "live" ? "Live" : "Test"} public key`} full>
                <input className="input" value={entered[mode].public} placeholder={paystack.publicKeys[mode] ?? `pk_${mode}_…`} onChange={(event) => enter(mode, "public", event.target.value)} />
              </Field>
            </fieldset>
          ),
        )}
        {paystack.callbackEnvManaged ? (
          <EnvNote variable="PAYSTACK_CALLBACK_URL" />
        ) : (
          <Field label="Callback URL" full hint="Where the payer lands after paying, when a payment doesn't name its own page. Blank uses this app's /invoices page.">
            <input className="input" value={callbackUrl} placeholder="https://…" onChange={(event) => setCallbackUrl(event.target.value)} />
          </Field>
        )}
        <Button
          disabled={connect.isPending}
          onClick={() => connect.mutate()}
        >
          {connect.isPending ? "Checking…" : "Save"}
        </Button>
        <ErrorNote error={connect.error} />
      </div>

      <CopyRow
        label="Callback URL"
        value={paystack.callbackUrl}
        hint={
          <>
            Optional in <span className="text-ink">Paystack → Settings → API Keys &amp; Webhooks</span>; each payment link already sends its
            own. Set it for both test and live.
          </>
        }
      />
      <CopyRow
        label="Webhook URL"
        value={paystack.webhookUrl}
        hint={
          <>
            Paste this into <span className="text-ink">Paystack → Settings → API Keys &amp; Webhooks</span>. Without it money is
            taken and the invoice is never marked paid — which looks exactly like the integration not working. Set it for both test
            and live.
          </>
        }
      />
    </Shell>
  );
}

export function HubtelPanel({ settings }: { settings: AppSettings }) {
  const save = useSave();
  const hubtel = settings.hubtel;

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [merchantId, setMerchantId] = useState(hubtel.merchantId ?? "");

  const [smsId, setSmsId] = useState("");
  const [smsSecret, setSmsSecret] = useState("");
  const [sender, setSender] = useState(hubtel.sms.sender ?? "");

  const connect = useMutation({
    mutationFn: () => api.put<AppSettings>("/settings/hubtel", { clientId, clientSecret, merchantId }),
    onSuccess: (result) => {
      setClientId("");
      setClientSecret("");
      save(result);
    },
  });
  const remove = useMutation({ mutationFn: () => api.delete<AppSettings>("/settings/hubtel"), onSuccess: save });
  const connectSms = useMutation({
    mutationFn: () => api.put<AppSettings>("/settings/hubtel-sms", { smsId, smsSecret, sender: sender || undefined }),
    onSuccess: (result) => {
      setSmsId("");
      setSmsSecret("");
      save(result);
    },
  });

  return (
    <Shell
      title="Hubtel"
      what={
        <>
          Mobile money — a prompt that arrives on the client's phone rather than a page they have to visit. For a great many small
          businesses here, that is the thing that actually gets completed.
        </>
      }
      state={
        hubtel.configured ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge tone="positive">connected</Badge>
            <code className="font-mono text-xs">{hubtel.clientId}</code>
            <span className="text-muted">merchant {hubtel.merchantId}</span>
            {!hubtel.envManaged && (
              <button
                type="button"
                className="font-sans text-[11px] uppercase tracking-[.06em] text-danger-text/70 transition hover:text-danger-text"
                onClick={() => remove.mutate()}
              >
                disconnect
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <Badge tone="muted">not set up</Badge>
            <span>
              The API client id, secret and Merchant Account number from{" "}
              <a className="text-blue hover:underline" href="https://unity.hubtel.com" target="_blank" rel="noreferrer">
                unity.hubtel.com
              </a>
              .
            </span>
          </div>
        )
      }
    >
      {hubtel.envManaged ? (
        <EnvNote variable="HUBTEL_CLIENT_ID" />
      ) : (
        <div className="mt-4 grid max-w-2xl gap-3 sm:grid-cols-2">
          <Field label="Client id" hint="From the Hubtel API settings.">
            <input className="input" value={clientId} onChange={(event) => setClientId(event.target.value)} />
          </Field>
          <Field label="Client secret">
            <input className="input" type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} />
          </Field>
          <Field label="Merchant account number" full hint="The account the money lands in. Checked against Hubtel before it is stored.">
            <input className="input" value={merchantId} onChange={(event) => setMerchantId(event.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Button
              disabled={connect.isPending || !clientId.trim() || !clientSecret.trim() || !merchantId.trim()}
              onClick={() => connect.mutate()}
            >
              {connect.isPending ? "Checking…" : hubtel.configured ? "Replace the credentials" : "Connect Hubtel"}
            </Button>
            <ErrorNote error={connect.error} />
          </div>
        </div>
      )}

      <CopyRow
        label="Callback URL"
        value={hubtel.callbackUrl}
        hint={
          <>
            Paste this into the Hubtel checkout settings. Hubtel does not sign its callbacks, so this app treats one as a nudge and
            asks Hubtel directly before it marks anything paid — a callback on its own is never believed.
          </>
        }
      />

      <div className="mt-6 border-t border-line pt-5">
        <h3 className="font-display text-lg">Text messages</h3>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          A payment reminder or an appointment confirmation, by SMS. <strong>Hubtel issues a different credential pair for this</strong>
          {" "}than for payments, and using one for the other returns an unhelpful 401 — so it is asked for separately.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          {hubtel.sms.configured ? (
            <>
              <Badge tone="positive">connected</Badge>
              <code className="font-mono text-xs">{hubtel.sms.smsId}</code>
              {hubtel.sms.sender && <span className="text-muted">from “{hubtel.sms.sender}”</span>}
            </>
          ) : (
            <Badge tone="muted">not set up</Badge>
          )}
        </div>

        {hubtel.sms.envManaged ? (
          <EnvNote variable="HUBTEL_SMS_ID" />
        ) : (
          <div className="mt-3 grid max-w-2xl gap-3 sm:grid-cols-2">
            <Field label="SMS client id">
              <input className="input" value={smsId} onChange={(event) => setSmsId(event.target.value)} />
            </Field>
            <Field label="SMS client secret">
              <input className="input" type="password" value={smsSecret} onChange={(event) => setSmsSecret(event.target.value)} />
            </Field>
            <Field
              label="Sender id"
              full
              hint="Up to 11 characters. An alphanumeric sender must be registered with Hubtel first, or messages fail one at a time. Leave blank to send from the merchant number."
            >
              <input className="input" maxLength={11} value={sender} placeholder="DakyXTech" onChange={(event) => setSender(event.target.value)} />
            </Field>
            <div className="sm:col-span-2">
              <Button disabled={connectSms.isPending || !smsId.trim() || !smsSecret.trim()} onClick={() => connectSms.mutate()}>
                {connectSms.isPending ? "Saving…" : "Save SMS credentials"}
              </Button>
              <ErrorNote error={connectSms.error} />
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}

/**
 * Which repositories agents may change.
 *
 * Separate from the GitHub token because they are different decisions: the
 * token decides what this app can *see*, and this decides what an agent may
 * *change*. Empty is the shipped state and is meaningful — an agent can read
 * any repository the token reaches and write to none until somebody types a
 * name here.
 */
export function AgentReposPanel({ settings }: { settings: AppSettings }) {
  const save = useSave();
  const [repos, setRepos] = useState(settings.agentRepos.repos);

  const write = useMutation({
    mutationFn: () => api.put<AppSettings>("/settings/github-repos", { repos }),
    onSuccess: save,
  });

  return (
    <Shell
      title="What agents may change"
      what={
        <>
          Repositories the developer agents may open a pull request against. Reading a codebase is research; writing to one changes
          software that runs. <strong>An agent never merges</strong> — merging is an approval you give, and on this repository it
          deploys.
        </>
      }
      state={
        settings.agentRepos.writable ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge tone="warn">agents can propose changes</Badge>
            <code className="font-mono text-xs">{settings.agentRepos.repos}</code>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <Badge tone="muted">read-only</Badge>
            <span>No repository is writable. Agents can read code and open issues, and change nothing.</span>
          </div>
        )
      }
    >
      {settings.agentRepos.envManaged ? (
        <EnvNote variable="GITHUB_ALLOWED_REPOS" />
      ) : (
        <div className="mt-4 max-w-xl space-y-3">
          {/* Said where the field is, not only in a boot log. A bare entry
              stopped matching anything the day the rule was narrowed, and the
              symptom is a publish refused two screens away. */}
          {settings.agentRepos.bare.length > 0 && (
            <p className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
              {settings.agentRepos.bare.join(", ")} {settings.agentRepos.bare.length === 1 ? "names" : "name"} no owner, so{" "}
              {settings.agentRepos.bare.length === 1 ? "it matches" : "they match"} nothing. Write each as{" "}
              <code className="font-mono text-xs">owner/name</code> — a repository name on its own is not unique, and it used to
              match one belonging to anybody.
            </p>
          )}
          <Field
            label="Writable repositories"
            full
            hint="One per line, or comma separated. Each must name its owner — owner/name. Use * to allow everything the token can see."
          >
            <textarea rows={3} className="input font-mono text-xs" value={repos} placeholder="Daky0000/dakyworld" onChange={(event) => setRepos(event.target.value)} />
          </Field>
          <Button disabled={write.isPending || repos === settings.agentRepos.repos} onClick={() => write.mutate()}>
            {write.isPending ? "Saving…" : "Save"}
          </Button>
          <ErrorNote error={write.error} />
        </div>
      )}
    </Shell>
  );
}
