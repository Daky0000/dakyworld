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
      <p className="mt-1 max-w-2xl text-sm text-ink/60">{what}</p>
      <div className="mt-4 border-y border-ink/10 py-4">{state}</div>
      {children}
    </section>
  );
}

function CopyRow({ label, value, hint }: { label: string; value: string; hint: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4">
      <p className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">{label}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <code className="break-all border border-line bg-cream px-2 py-1 font-mono text-xs">{value}</code>
        <button
          type="button"
          className="font-mono text-[10px] uppercase tracking-[.12em] text-blue transition hover:underline"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <p className="mt-1 max-w-2xl text-xs text-ink/50">{hint}</p>
    </div>
  );
}

function ErrorNote({ error }: { error: unknown }) {
  if (!(error instanceof Error)) return null;
  return <p className="mt-3 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error.message}</p>;
}

function EnvNote({ variable }: { variable: string }) {
  return (
    <p className="mt-3 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      Pinned by the <code className="font-mono">{variable}</code> environment variable, so it can't be edited here.
    </p>
  );
}

export function PaystackPanel({ settings }: { settings: AppSettings }) {
  const save = useSave();
  const [secretKey, setSecretKey] = useState("");
  const paystack = settings.paystack;

  const connect = useMutation({
    mutationFn: () => api.put<AppSettings>("/settings/paystack", { secretKey }),
    onSuccess: (result) => {
      setSecretKey("");
      save(result);
    },
  });
  const remove = useMutation({ mutationFn: () => api.delete<AppSettings>("/settings/paystack"), onSuccess: save });

  return (
    <Shell
      title="Paystack"
      what={
        <>
          A payment page for an invoice — card, mobile money or bank transfer, on one link you can put in an email. Stripe does not
          acquire in Ghana, so this is what makes a GHS invoice payable at all.
        </>
      }
      state={
        paystack.configured ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge tone="positive">connected</Badge>
            <code className="font-mono text-xs">{paystack.key}</code>
            <Badge tone={paystack.livemode ? "warn" : "muted"}>{paystack.livemode ? "live — real money" : "test mode"}</Badge>
            {!paystack.envManaged && (
              <button
                type="button"
                className="font-mono text-[10px] uppercase tracking-[.12em] text-red-600/70 transition hover:text-red-600"
                onClick={() => remove.mutate()}
              >
                disconnect
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm text-ink/60">
            <Badge tone="muted">not set up</Badge>
            <span>
              Secret key from{" "}
              <a className="text-blue hover:underline" href="https://dashboard.paystack.com/#/settings/developers" target="_blank" rel="noreferrer">
                dashboard.paystack.com → Settings → API Keys
              </a>
              . Use a <code className="font-mono text-xs">sk_test_…</code> key until you are ready to take real money.
            </span>
          </div>
        )
      }
    >
      {paystack.envManaged ? (
        <EnvNote variable="PAYSTACK_SECRET_KEY" />
      ) : (
        <div className="mt-4 max-w-xl space-y-3">
          <Field label="Secret key" full hint="Checked against Paystack before it is stored, so a typo is caught here rather than at the first invoice.">
            <input className="input" type="password" value={secretKey} placeholder="sk_test_…" onChange={(event) => setSecretKey(event.target.value)} />
          </Field>
          <Button disabled={connect.isPending || secretKey.trim().length < 10} onClick={() => connect.mutate()}>
            {connect.isPending ? "Checking…" : paystack.configured ? "Replace the key" : "Connect Paystack"}
          </Button>
          <ErrorNote error={connect.error} />
        </div>
      )}

      <CopyRow
        label="Webhook URL"
        value={paystack.webhookUrl}
        hint={
          <>
            Paste this into <span className="text-ink/70">Paystack → Settings → API Keys &amp; Webhooks</span>. Without it money is
            taken and the invoice is never marked paid — which looks exactly like the integration not working.
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
            <span className="text-ink/50">merchant {hubtel.merchantId}</span>
            {!hubtel.envManaged && (
              <button
                type="button"
                className="font-mono text-[10px] uppercase tracking-[.12em] text-red-600/70 transition hover:text-red-600"
                onClick={() => remove.mutate()}
              >
                disconnect
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm text-ink/60">
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

      <div className="mt-6 border-t border-ink/10 pt-5">
        <h3 className="font-display text-lg">Text messages</h3>
        <p className="mt-1 max-w-2xl text-sm text-ink/60">
          A payment reminder or an appointment confirmation, by SMS. <strong>Hubtel issues a different credential pair for this</strong>
          {" "}than for payments, and using one for the other returns an unhelpful 401 — so it is asked for separately.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          {hubtel.sms.configured ? (
            <>
              <Badge tone="positive">connected</Badge>
              <code className="font-mono text-xs">{hubtel.sms.smsId}</code>
              {hubtel.sms.sender && <span className="text-ink/50">from “{hubtel.sms.sender}”</span>}
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
              <input className="input" maxLength={11} value={sender} placeholder="Dakyworld" onChange={(event) => setSender(event.target.value)} />
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
          <div className="flex flex-wrap items-center gap-3 text-sm text-ink/60">
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
          <Field
            label="Writable repositories"
            full
            hint="One per line, or comma separated — owner/name, or just the name when a default owner is set. Use * to allow everything the token can see."
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
