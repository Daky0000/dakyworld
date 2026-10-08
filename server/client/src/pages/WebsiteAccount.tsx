import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiUrl, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { setPageTitle } from "../lib/surface";
import type { SiteSummary } from "../lib/types";
import { Button, Field, PageHeader } from "../components/ui";
import { TwoFactorControls, useTwoFactorState } from "../components/TwoFactorControls";
import { NewPasswordField, PasswordInput } from "../components/PasswordField";
import { passwordStrength } from "../lib/passwordStrength";

/**
 * Everything a customer can do about their own account without asking anybody:
 * change the password, turn on two-step sign-in, see where they are signed in
 * and end the sessions they do not recognise, take a copy of a website or
 * delete it, and close the account.
 *
 * Deleting is never immediate. A website goes offline at once and is erased
 * thirty days later; an account is switched off at once and its details erased
 * thirty days later (server: services/websiteDeletion.ts). Until then a website
 * can be restored from here, and the screen says so beside every button that
 * deletes anything.
 */

type SessionRow = { id: string; createdAt: string; lastActiveAt: string; expiresAt: string; current: boolean };

const day = (value: string | Date) => new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
const moment = (value: string) => new Date(value).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const message = (error: unknown) => (error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong.");

function Section({ title, intro, children, tone }: { title: string; intro?: ReactNode; children: ReactNode; tone?: "danger" }) {
  return (
    <section className={`rounded-2xl border bg-white p-5 sm:p-6 ${tone === "danger" ? "border-danger-line" : "border-line"}`}>
      <h2 className="font-display text-lg text-ink">{title}</h2>
      {intro && <p className="mt-1 max-w-2xl text-sm text-muted">{intro}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Notice({ kind, children }: { kind: "ok" | "error"; children: ReactNode }) {
  return (
    <p
      role={kind === "error" ? "alert" : "status"}
      className={`mt-3 rounded-xl border px-3.5 py-2.5 text-sm ${kind === "error" ? "border-danger-line bg-danger-surface text-danger-text" : "border-positive-line bg-positive-surface text-positive-text"}`}
    >
      {children}
    </p>
  );
}

function PasswordSection() {
  const { user } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = useMutation({
    mutationFn: () => api.post("/auth/password", { currentPassword: current, newPassword: next }),
    // A new password signs every device out, this one included, so the next
    // screen is the sign-in page.
    onSuccess: () => window.setTimeout(() => window.location.assign("/"), 1800),
  });
  return (
    <Section title="Password" intro="Changing it signs you out everywhere, including here — sign back in with the new one.">
      <form
        className="grid max-w-xl gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          change.mutate();
        }}
      >
        <Field label="Current password">
          <PasswordInput autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <NewPasswordField value={next} onChange={setNext} context={{ email: user?.email, name: user?.name }} />
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={change.isPending || !current || !passwordStrength(next, { email: user?.email, name: user?.name }).acceptable}>
            {change.isPending ? "Changing…" : "Change password"}
          </Button>
        </div>
      </form>
      {change.isSuccess && <Notice kind="ok">Password changed. Taking you to sign in…</Notice>}
      {change.error && <Notice kind="error">{message(change.error)}</Notice>}
    </Section>
  );
}

function TwoStepSection() {
  const { data } = useTwoFactorState();
  return (
    <Section
      title="Two-step sign-in"
      intro={
        data?.enabled
          ? `On${data.enabledAt ? ` since ${day(data.enabledAt)}` : ""}. ${data.recoveryCodesRemaining} recovery code${data.recoveryCodesRemaining === 1 ? "" : "s"} left.`
          : "Off. With it on, somebody who learns your password still cannot sign in without the code from your phone."
      }
    >
      <TwoFactorControls data={data} />
    </Section>
  );
}

function SessionsSection() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["auth", "sessions"], queryFn: ({ signal }) => api.get<{ sessions: SessionRow[] }>("/auth/sessions", signal) });
  const others = useMutation({
    mutationFn: () => api.post<{ revoked: number }>("/auth/sessions/revoke-others", {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["auth", "sessions"] }),
  });
  const rows = sessions.data?.sessions ?? [];
  return (
    <Section title="Where you're signed in" intro="Each browser or phone you have signed in on. If you don't recognise one, sign out everywhere else and change your password.">
      {sessions.isLoading && <p className="text-sm text-muted" role="status">Loading…</p>}
      {sessions.error && <Notice kind="error">{message(sessions.error)}</Notice>}
      {rows.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <span className="text-ink">
                {row.current ? <strong>This browser</strong> : "Another browser or phone"}
                <span className="ml-2 text-muted">signed in {moment(row.createdAt)}</span>
              </span>
              <span className="text-xs text-muted">last used {moment(row.lastActiveAt)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4">
        <Button variant="secondary" disabled={others.isPending || rows.filter((row) => !row.current).length === 0} onClick={() => others.mutate()}>
          {others.isPending ? "Signing out…" : "Sign out everywhere else"}
        </Button>
      </div>
      {others.data && <Notice kind="ok">Signed out of {others.data.revoked} other {others.data.revoked === 1 ? "session" : "sessions"}.</Notice>}
      {others.error && <Notice kind="error">{message(others.error)}</Notice>}
    </Section>
  );
}

function SiteRow({ site }: { site: SiteSummary }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["website"] });
  const erase = useMutation({
    mutationFn: () => api.post<{ message: string }>(`/website/sites/${encodeURIComponent(site.id)}/erase`, { confirmName: typed }),
    onSuccess: () => { setConfirming(false); setTyped(""); refresh(); },
  });
  const restore = useMutation({
    mutationFn: () => api.post<{ message: string }>(`/website/sites/${encodeURIComponent(site.id)}/erase/cancel`, {}),
    onSuccess: refresh,
  });
  const held = site.deletionScheduledFor;
  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-sm font-semibold text-ink">{site.name}</p>
          <p className="mt-0.5 text-xs text-muted">
            {held ? <span className="font-semibold text-danger-text">Offline — erased on {day(held)} unless you restore it</span> : site.customDomain || site.hostedUrl || site.publicUrl}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a className="inline-flex h-9 items-center rounded-xl border border-line px-3 text-xs font-semibold text-ink hover:border-line-strong" href={apiUrl(`/website/sites/${encodeURIComponent(site.id)}/export`)} download>
            Download a copy
          </a>
          {held ? (
            <Button size="sm" disabled={restore.isPending} onClick={() => restore.mutate()}>
              {restore.isPending ? "Restoring…" : "Restore website"}
            </Button>
          ) : (
            <Button size="sm" variant="danger" disabled={confirming} onClick={() => setConfirming(true)}>
              Delete website…
            </Button>
          )}
        </div>
      </div>
      {confirming && !held && (
        <form
          className="mt-3 rounded-xl border border-danger-line bg-danger-surface p-4"
          onSubmit={(event) => {
            event.preventDefault();
            erase.mutate();
          }}
        >
          <p className="text-sm text-danger-text">
            The website goes offline straight away and is erased in 30 days, with its pages, pictures and history. You can restore it from here until then.
            Download a copy first if you might want it.
          </p>
          <Field label={`Type “${site.name}” to confirm`}>
            <input className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </Field>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="submit" variant="danger" disabled={erase.isPending || typed.trim().toLowerCase() !== site.name.trim().toLowerCase()}>
              {erase.isPending ? "Deleting…" : "Delete this website"}
            </Button>
            <Button variant="secondary" onClick={() => { setConfirming(false); setTyped(""); erase.reset(); }}>
              Keep it
            </Button>
          </div>
          {erase.error && <Notice kind="error">{message(erase.error)}</Notice>}
        </form>
      )}
      {erase.data && <Notice kind="ok">{erase.data.message}</Notice>}
      {restore.data && <Notice kind="ok">{restore.data.message}</Notice>}
      {restore.error && <Notice kind="error">{message(restore.error)}</Notice>}
    </li>
  );
}

function WebsitesSection() {
  const sites = useQuery({ queryKey: ["website", "sites", "account"], queryFn: ({ signal }) => api.get<SiteSummary[]>("/website/sites?limit=100", signal) });
  const yours = (sites.data ?? []).filter((site) => site.capabilities?.manage);
  if (!sites.isLoading && yours.length === 0) return null;
  return (
    <Section title="Your websites" intro="Take a copy of everything we hold for a website — its pages, history and the list of its pictures — or delete it.">
      {sites.isLoading && <p className="text-sm text-muted" role="status">Loading…</p>}
      {sites.error && <Notice kind="error">{message(sites.error)}</Notice>}
      {yours.length > 0 && <ul className="divide-y divide-line rounded-xl border border-line">{yours.map((site) => <SiteRow key={site.id} site={site} />)}</ul>}
    </Section>
  );
}

function CloseAccountSection() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const close = useMutation({
    mutationFn: () => api.post<{ message: string }>("/auth/account/delete", { password, confirm }),
    onSuccess: () => window.setTimeout(() => window.location.assign("/"), 6000),
  });
  return (
    <Section
      tone="danger"
      title="Close your account"
      intro={
        <>
          You are signed out everywhere at once, and your name, email address and sign-in details are erased after 30 days. Websites only you
          use are deleted with it. Invoices and payment records are kept, because the law requires it. If you are paying, cancel first under{" "}
          <Link className="font-semibold text-ink underline underline-offset-2" to="/website/balance">Balance & invoices</Link>.
        </>
      }
    >
      {close.data ? (
        <Notice kind="ok">{close.data.message}</Notice>
      ) : !open ? (
        <Button variant="danger" onClick={() => setOpen(true)}>Close my account…</Button>
      ) : (
        <form
          className="grid max-w-xl gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            close.mutate();
          }}
        >
          <Field label="Your password">
            <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Type DELETE to confirm">
            <input className="input" autoComplete="off" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" variant="danger" disabled={close.isPending || !password || confirm.trim() !== "DELETE"}>
              {close.isPending ? "Closing…" : "Close my account"}
            </Button>
            <Button variant="secondary" onClick={() => { setOpen(false); setPassword(""); setConfirm(""); close.reset(); }}>
              Keep my account
            </Button>
          </div>
          {close.error && <div className="sm:col-span-2"><Notice kind="error">{message(close.error)}</Notice></div>}
        </form>
      )}
    </Section>
  );
}

export function WebsiteAccount() {
  const { user } = useAuth();
  useEffect(() => setPageTitle("Your account"), []);
  if (!user) return null;
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="Your account" subtitle={`${user.name} · ${user.email}`} />
      <PasswordSection />
      <TwoStepSection />
      <SessionsSection />
      <WebsitesSection />
      {/* Staff accounts are closed by an administrator, so the button would only ever refuse. */}
      {user.external && <CloseAccountSection />}
    </div>
  );
}
