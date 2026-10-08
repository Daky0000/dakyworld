import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { SURFACE_NAME, currentSurface, setPageTitle } from "../lib/surface";

/**
 * The three screens somebody reaches from a link in an email, plus the "I have
 * forgotten it" form on the sign-in page.
 *
 * They are deliberately outside the signed-in app: everybody who arrives here
 * is by definition unable to sign in. `main.tsx` shows them before the auth
 * gate, from the path alone.
 */

function Shell({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => setPageTitle(title), [title]);
  return (
    <main className="grid min-h-screen place-items-center bg-cream p-6">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-8">
        <img src="/brand/lockup-on-light.png" alt={SURFACE_NAME[currentSurface()]} className="mb-5 block h-7 w-auto" />
        <h1 className="font-display text-xl font-medium text-ink">{title}</h1>
        <div className="mt-5 space-y-4 text-sm text-ink">{children}</div>
      </div>
    </main>
  );
}

function tokenFromUrl(): string {
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

/** Sets a first password (after a purchase or an invite) or a replacement one. */
export function SetPassword({ kind }: { kind: "SET_PASSWORD" | "PASSWORD_RESET" }) {
  const [token, setToken] = useState(() => tokenFromUrl());
  const [email, setEmail] = useState(() => new URLSearchParams(window.location.search).get("email") ?? "");
  const [verifying, setVerifying] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reference = new URLSearchParams(window.location.search).get("reference") || new URLSearchParams(window.location.search).get("trxref") || "";
  const isOnboarding = new URLSearchParams(window.location.search).get("onboarding") === "true" || kind === "SET_PASSWORD";

  useEffect(() => {
    if (!token && reference) {
      setVerifying(true);
      api
        .post<{ paid: boolean; token?: string; email?: string }>("/public/website-payment-status", { reference })
        .then((res) => {
          if (res.token) setToken(res.token);
          if (res.email) setEmail(res.email);
        })
        .catch((err) => setError((err as Error).message))
        .finally(() => setVerifying(false));
    }
  }, [token, reference]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("The two passwords are not the same.");
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/password/token", { token, password, kind });
      // Signed in by the same request, so go straight on. A new customer lands
      // on the welcome flow (/website/welcome), which sends anybody who already
      // has a website to their pages; /website/onboarding is the staff checklist.
      window.location.href = isOnboarding ? "/website/welcome" : "/";
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (verifying) {
    return (
      <Shell title="Verifying payment…">
        <p className="text-sm text-muted">
          Confirming your purchase with Paystack and preparing your account setup…
        </p>
      </Shell>
    );
  }

  if (!token) {
    return (
      <Shell title="That link is incomplete">
        <p className="text-muted">
          The address is missing its token. Open the link from the email again, or ask for a new one from the sign-in
          screen.
        </p>
      </Shell>
    );
  }

  const title = kind === "PASSWORD_RESET" ? "Choose a new password" : "Create your password";

  return (
    <Shell title={title}>
      {isOnboarding && (
        <p className="text-xs leading-relaxed text-muted">
          Create a secure password for your account to access the website editor and complete your onboarding.
        </p>
      )}
      {email && (
        <div className="rounded-xl border border-line bg-cream p-3 text-xs text-ink">
          <span className="block text-[11px] font-medium uppercase tracking-wide text-muted">Account email</span>
          <span className="mt-0.5 block text-sm font-semibold text-ink">{email}</span>
        </div>
      )}
      <form className="space-y-4" onSubmit={submit}>
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">New password</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            className="mt-1 w-full rounded-xl border border-line bg-cream px-3 py-2 text-ink"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Confirm password</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            className="mt-1 w-full rounded-xl border border-line bg-cream px-3 py-2 text-ink"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </label>
        <p className="text-xs text-muted">At least 10 characters. Longer beats complicated.</p>
        {error && <p className="rounded-lg bg-warn-surface p-3 text-xs text-warn-text">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full cursor-pointer rounded-xl bg-ink px-4 py-2.5 font-medium text-white transition hover:bg-ink/90 disabled:opacity-60"
        >
          {busy ? "Saving…" : isOnboarding ? "Create password & Continue to Onboarding →" : "Save and sign in"}
        </button>
      </form>
    </Shell>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    // The answer is the same whether or not the address is known, so there is
    // nothing to branch on and nothing to report.
    await api.post("/auth/password/forgot", { email }).catch(() => undefined);
    setSent(true);
    setBusy(false);
  }

  if (sent) {
    return (
      <Shell title="Check your email">
        <p className="text-muted">
          If {email} has an account, a link to choose a new password is on its way. It is good for one hour.
        </p>
        <a className="text-blue hover:underline" href="/">
          Back to sign in
        </a>
      </Shell>
    );
  }

  return (
    <Shell title="Forgotten password">
      <form className="space-y-4" onSubmit={submit}>
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Your email address</span>
          <input
            type="email"
            required
            autoComplete="email"
            className="mt-1 w-full rounded-xl border border-line bg-cream px-3 py-2"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-ink px-4 py-2.5 font-medium text-white disabled:opacity-60"
        >
          {busy ? "Sending…" : "Send me a link"}
        </button>
        <a className="block text-center text-xs text-muted hover:underline" href="/">
          Back to sign in
        </a>
      </form>
    </Shell>
  );
}

export function VerifyEmail() {
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const token = tokenFromUrl();
    if (!token) {
      setState("failed");
      setMessage("The address is missing its token.");
      return;
    }
    api
      .post<{ email: string }>("/auth/email/verify", { token })
      .then((result) => {
        setState("done");
        setMessage(result.email);
      })
      .catch((err: Error) => {
        setState("failed");
        setMessage(err.message);
      });
  }, []);

  return (
    <Shell title={state === "done" ? "Address confirmed" : state === "failed" ? "That link did not work" : "Confirming…"}>
      {state === "done" && <p className="text-muted">{message} is confirmed. You can close this tab.</p>}
      {state === "failed" && <p className="text-muted">{message}</p>}
      {state !== "working" && (
        <a className="text-blue hover:underline" href="/">
          Go to {SURFACE_NAME[currentSurface()]}
        </a>
      )}
    </Shell>
  );
}
