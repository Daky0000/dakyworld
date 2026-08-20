import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { AppSettings } from "../lib/types";
import { Badge, Button, Field } from "./ui";

/**
 * WhatsApp and the SMS callbacks.
 *
 * The panel that has to explain a constraint rather than just collect a key.
 * Every other integration in Settings is "paste this and it works"; this one
 * has a rule behind it that decides what the app can do, and hiding the rule
 * would mean the Owner learns it from a failed send to a real prospect:
 *
 * **A business may write freely to somebody only within 24 hours of that
 * person's last message.** Outside it, only a template Meta approved in
 * advance. A cold lead has never written to us, so a first WhatsApp is always
 * a template and always waits for review.
 *
 * Which is why the wa.me path is described here as an equal rather than as a
 * fallback: it works today, needs none of this, and arrives from a person.
 *
 * **Both callback URLs are shown whether or not anything is connected.**
 * Pasting the URL into somebody else's dashboard is the step most likely to be
 * missed, and missing it does not look like a missing setting — replies simply
 * never arrive, so a prospect who answered appears not to have.
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

const QUALITY_TONE: Record<string, "positive" | "warn" | "muted"> = { GREEN: "positive", YELLOW: "warn", RED: "warn" };

export function WhatsAppPanel({ settings }: { settings: AppSettings }) {
  const save = useSave();
  const whatsapp = settings.messaging.whatsapp;

  const [token, setToken] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState(whatsapp.phoneNumberId ?? "");
  const [businessId, setBusinessId] = useState(whatsapp.businessId ?? "");
  const [appSecret, setAppSecret] = useState("");

  const connect = useMutation({
    mutationFn: () => api.put<AppSettings>("/settings/whatsapp", { token, phoneNumberId, businessId: businessId || undefined, appSecret: appSecret || undefined }),
    onSuccess: (result) => {
      setToken("");
      setAppSecret("");
      save(result);
    },
  });
  const remove = useMutation({ mutationFn: () => api.delete<AppSettings>("/settings/whatsapp"), onSuccess: save });

  return (
    <Shell
      title="WhatsApp"
      what={
        <>
          The way to reach a lead who has a phone number and no email — which, on a scraped list, is most of them. Messages are drafted from the
          same evidence an email is and go out under the same rules.
        </>
      }
      state={
        whatsapp.configured ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Badge tone="positive">connected</Badge>
              {whatsapp.number?.displayNumber && <code className="font-mono text-xs">{whatsapp.number.displayNumber}</code>}
              {whatsapp.number?.verifiedName && <span className="text-ink/50">{whatsapp.number.verifiedName}</span>}
              {whatsapp.number?.qualityRating && (
                <Badge tone={QUALITY_TONE[whatsapp.number.qualityRating] ?? "muted"}>quality {whatsapp.number.qualityRating.toLowerCase()}</Badge>
              )}
              {!whatsapp.envManaged && (
                <button
                  type="button"
                  className="font-mono text-[10px] uppercase tracking-[.12em] text-red-600/70 transition hover:text-red-600"
                  onClick={() => remove.mutate()}
                >
                  disconnect
                </button>
              )}
            </div>
            <p className="text-xs text-ink/50">
              {whatsapp.approvedTemplates > 0
                ? `${whatsapp.approvedTemplates} approved template${whatsapp.approvedTemplates === 1 ? "" : "s"}.`
                : "No approved template yet, so a first message can only go out as a wa.me link."}
            </p>
            {whatsapp.numberError && <p className="text-xs text-amber-700">{whatsapp.numberError}</p>}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm text-ink/60">
            <Badge tone="muted">not set up</Badge>
            <span>
              A permanent access token and the phone number ID from{" "}
              <a className="text-blue hover:underline" href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer">
                developers.facebook.com
              </a>{" "}
              → your app → WhatsApp → API Setup.
            </span>
          </div>
        )
      }
    >
      {!whatsapp.envManaged && (
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Field label="Access token" hint="Use a System User token. A temporary one works for 24 hours and then silently stops.">
            <input className="input" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="EAAG…" />
          </Field>
          <Field label="Phone number ID" hint="The numeric id under the number — not the number itself.">
            <input className="input" value={phoneNumberId} onChange={(event) => setPhoneNumberId(event.target.value)} placeholder="123456789012345" />
          </Field>
          <Field label="Business account ID" hint="Only needed for templates. Without it, messages send but templates can't be read.">
            <input className="input" value={businessId} onChange={(event) => setBusinessId(event.target.value)} placeholder="987654321098765" />
          </Field>
          <Field label="App secret" hint="Signs the inbound webhook. Without it, replies are recorded and never acted on.">
            <input className="input" type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Button onClick={() => connect.mutate()} disabled={!token || !phoneNumberId || connect.isPending}>
              {connect.isPending ? "Checking with Meta…" : "Connect WhatsApp"}
            </Button>
            <ErrorNote error={connect.error} />
          </div>
        </div>
      )}

      {whatsapp.envManaged && (
        <p className="mt-3 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Pinned by the <code className="font-mono">WHATSAPP_TOKEN</code> environment variable, so it can't be edited here.
        </p>
      )}

      <CopyRow
        label="Callback URL"
        value={whatsapp.callbackUrl}
        hint={
          <>
            Paste this into the WhatsApp product's Configuration tab, with the verify token below. Without it, a prospect's reply never reaches
            this app — and a reply is the only thing that opens the 24-hour window to answer in your own words.
          </>
        }
      />

      {whatsapp.verifyToken && (
        <CopyRow
          label="Verify token"
          value={whatsapp.verifyToken}
          hint="Meta asks for this once, when the callback URL is saved. It is not a credential — it only proves the URL belongs to whoever configured it."
        />
      )}

      {whatsapp.configured && !whatsapp.inboundTrusted && (
        <p className="mt-4 border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          No app secret is set, so inbound replies are stored and <strong>not acted on</strong>. That is deliberate: an unverified inbound could
          open a free-form window to any number, or opt a live prospect out. Add the secret to turn replies back on.
        </p>
      )}

      <div className="mt-5 border-t border-ink/10 pt-4">
        <p className="max-w-2xl text-sm text-ink/55">
          <strong className="text-ink/75">You do not have to wait for any of this.</strong> A wa.me link opens WhatsApp on your own phone with
          the message already typed, needs no Business account and no template review, and arrives from you rather than from a brand — which is
          what a small business here actually replies to. Every message in the composer offers that route.
        </p>
      </div>
    </Shell>
  );
}

export function SmsCallbackPanel({ settings }: { settings: AppSettings }) {
  const save = useSave();
  const sms = settings.messaging.sms;

  const mint = useMutation({
    mutationFn: () => api.post<AppSettings>("/settings/sms-callback-token"),
    onSuccess: save,
  });

  return (
    <Shell
      title="SMS replies"
      what={
        <>
          Hubtel's SMS credentials live under Payments — it issues one pair for both. What is set here is the address Hubtel posts replies and
          delivery reports back to, so a "STOP" actually stops something.
        </>
      }
      state={
        sms.inboundTrusted ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge tone="positive">callbacks trusted</Badge>
            <span className="text-ink/50">Replies and delivery reports are acted on.</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm text-ink/60">
            <Badge tone="muted">no callback token</Badge>
            <span>Inbound texts are recorded and not acted on, so a reply of STOP would not stop anything.</span>
          </div>
        )
      }
    >
      <p className="mt-4 max-w-2xl text-sm text-ink/55">
        Hubtel signs nothing, unlike Meta and Stripe. So the only thing separating a real delivery report from anybody who guesses the address is
        a secret inside the URL itself — which is why these two links carry one and must not be shortened or shared.
      </p>

      <div className="mt-4">
        <Button variant="secondary" onClick={() => mint.mutate()} disabled={mint.isPending}>
          {sms.inboundToken ? "Generate a new token" : "Generate a callback token"}
        </Button>
        {sms.inboundToken && (
          <p className="mt-2 text-xs text-amber-700">
            Generating a new one invalidates whatever is in Hubtel's dashboard now, and replies stop being acted on until it is replaced.
          </p>
        )}
        <ErrorNote error={mint.error} />
      </div>

      {sms.inboundUrl && (
        <CopyRow label="Inbound SMS URL" value={sms.inboundUrl} hint="Hubtel dashboard → your SMS sender → callback for incoming messages." />
      )}
      {sms.statusUrl && (
        <CopyRow label="Delivery report URL" value={sms.statusUrl} hint="The same screen, under delivery reports. This is what marks a text delivered rather than merely sent." />
      )}
    </Shell>
  );
}
